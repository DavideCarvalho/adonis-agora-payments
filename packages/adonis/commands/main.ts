import { ListLoader } from '@adonisjs/core/ace';
import MakeBillable from './make_billable.js';
import PaymentsSync from './payments_sync.js';
import PaymentsWebhook from './payments_webhook.js';

/**
 * The commands barrel for `@adonis-agora/payments`. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/payments/commands')` (done by this package's
 * `configure`). The ace kernel imports this module and treats it as a commands loader: a
 * {@link ListLoader} over the payments commands (`make:billable`, `payments:webhook`,
 * `payments:sync`) provides their metadata and constructors.
 */
const loader = new ListLoader([MakeBillable, PaymentsWebhook, PaymentsSync]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
