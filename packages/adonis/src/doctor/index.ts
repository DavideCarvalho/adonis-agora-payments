import type { AgoraDoctorCheck } from './agora_doctor.js';
import { paymentsDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorRegistry,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { AGORA_DOCTOR_BINDING, registerDoctorChecks } from './agora_doctor.js';

/**
 * Every payments check, for `node ace agora:doctor --no-boot` (which imports this entry instead of
 * booting the providers).
 */
export const agoraDoctorChecks: AgoraDoctorCheck[] = paymentsDoctorChecks();
