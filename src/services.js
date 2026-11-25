// The parts of Handoff you can turn on, in any combination:
//
//   web       the web app: browse and drive Claude Code from a phone browser, phone notifications
//             HANDOFF_WEB (on by default). Needs a password (npm run setup) and, to reach it from
//             your phone, a tunnel.
//   whatsapp  WhatsApp alerts: a message when a session needs you; reply to answer or approve.
//             HANDOFF_WHATSAPP_ENABLED (npm run setup:whatsapp). Needs the WhatsApp sender (Docker).
//
// `npm start` starts what is turned on. With only WhatsApp alerts, nothing listens on a port and no
// password or tunnel is needed. A new part is added here, with `http: true` if it answers requests.
export const SERVICES = [
  { id: 'web', name: 'web app', http: true, on: cfg => !!cfg.web },
  { id: 'whatsapp', name: 'WhatsApp alerts', http: false, on: cfg => !!cfg.notify?.enabled }
];

export const enabledServices = cfg => SERVICES.filter(s => s.on(cfg));
// does anything need the HTTP server (and so the tunnel)?
export const needsHttp = cfg => enabledServices(cfg).some(s => s.http);
export const describeServices = cfg => enabledServices(cfg).map(s => s.name).join(', ') || 'nothing';

// What stops the turned-on parts from working: { errors } stop the start, { warnings } are printed.
export function checkServices(cfg) {
  const errors = [], warnings = [];
  const on = enabledServices(cfg);
  if (!on.length) {
    errors.push('Nothing to run: the web app is off (HANDOFF_WEB=false) and WhatsApp alerts are off.\n' +
      'Choose what you want with:  npm run setup');
    return { errors, warnings };
  }
  if (cfg.web && !cfg.passwordHash) {
    errors.push('The web app needs a password (HANDOFF_PASSWORD_HASH). Run:  npm run setup\n' +
      '(Only want WhatsApp alerts? Set HANDOFF_WEB=false in .env instead.)');
  }
  if (cfg.notify?.enabled && !(cfg.notify.token && cfg.notify.to)) {
    const msg = 'WhatsApp alerts are turned on (HANDOFF_WHATSAPP_ENABLED) but not set up. Run:  npm run setup:whatsapp';
    // on their own they are the only thing to run, so that is an error; next to the web app, a warning
    if (on.length === 1) errors.push(msg); else warnings.push(msg + '\nStarting without WhatsApp alerts for now.');
  }
  return { errors, warnings };
}
