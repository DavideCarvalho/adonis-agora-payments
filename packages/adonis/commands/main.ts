import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import MakeBillable from './make_billable.js';
import MakeWebhookHandler from './make_webhook_handler.js';
import PaymentsAuditList from './payments_audit_list.js';
import PaymentsCustomersList from './payments_customers_list.js';
import PaymentsDisputesEvidence from './payments_disputes_evidence.js';
import PaymentsDisputesList from './payments_disputes_list.js';
import PaymentsDisputesResolve from './payments_disputes_resolve.js';
import PaymentsDoctor from './payments_doctor.js';
import PaymentsHealth from './payments_health.js';
import PaymentsOrganizationsList from './payments_organizations_list.js';
import PaymentsOverview from './payments_overview.js';
import PaymentsPaymentsList from './payments_payments_list.js';
import PaymentsPaymentsRefund from './payments_payments_refund.js';
import PaymentsPaymentsShow from './payments_payments_show.js';
import PaymentsProvidersList from './payments_providers_list.js';
import PaymentsRenew from './payments_renew.js';
import PaymentsSubscriptionsCancel from './payments_subscriptions_cancel.js';
import PaymentsSubscriptionsList from './payments_subscriptions_list.js';
import PaymentsSubscriptionsReprice from './payments_subscriptions_reprice.js';
import PaymentsSubscriptionsResume from './payments_subscriptions_resume.js';
import PaymentsSubscriptionsShow from './payments_subscriptions_show.js';
import PaymentsSync from './payments_sync.js';
import PaymentsWebhook from './payments_webhook.js';
import PaymentsWebhookEventsList from './payments_webhook_events_list.js';
import PaymentsWebhookEventsRetry from './payments_webhook_events_retry.js';

/**
 * The commands barrel for `@adonis-agora/payments`. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/payments/commands')` (done by this package's
 * `configure`). The ace kernel imports this module and treats it as a commands loader: a
 * {@link ListLoader} over the payments commands (`make:billable`, `make:webhook-handler`,
 * `payments:webhook`, `payments:sync`, `payments:renew`, `payments:health`, `agora:doctor`,
 * `payments:doctor`, and the console's operator commands `payments:<noun>:<verb>`) provides their
 * metadata and constructors.
 */
const loader = new ListLoader([
  MakeBillable,
  MakeWebhookHandler,
  PaymentsWebhook,
  PaymentsSync,
  PaymentsRenew,
  PaymentsHealth,
  AgoraDoctor,
  PaymentsDoctor,
  PaymentsOverview,
  PaymentsPaymentsList,
  PaymentsPaymentsShow,
  PaymentsPaymentsRefund,
  PaymentsSubscriptionsList,
  PaymentsSubscriptionsShow,
  PaymentsSubscriptionsCancel,
  PaymentsSubscriptionsResume,
  PaymentsSubscriptionsReprice,
  PaymentsCustomersList,
  PaymentsDisputesList,
  PaymentsDisputesResolve,
  PaymentsDisputesEvidence,
  PaymentsWebhookEventsList,
  PaymentsWebhookEventsRetry,
  PaymentsAuditList,
  PaymentsProvidersList,
  PaymentsOrganizationsList,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
