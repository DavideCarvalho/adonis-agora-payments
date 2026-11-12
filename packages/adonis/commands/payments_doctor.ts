import AgoraDoctor from './agora_doctor.js';

/** `node ace payments:doctor`: `agora:doctor` for the payments checks only (same flags). */
export default class PaymentsDoctor extends AgoraDoctor {
  static override commandName = 'payments:doctor';
  static override description = 'Check the @adonis-agora/payments configuration';
  protected override presetLib: string | undefined = 'payments';
}
