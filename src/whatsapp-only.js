// WhatsApp alerts only: the same as `npm start` with the web app turned off (HANDOFF_WEB=false).
// Kept so setups made before parts could be turned on and off one by one keep working:
//
//   npm run whatsapp-only            (needs HANDOFF_WHATSAPP_* in .env: npm run setup:whatsapp)
import { start } from './index.js';

start({ web: false, logName: 'whatsapp-only.log' });
