import type { FeedbackAttempt } from '../db/workflow-feedback';

export function earlySetupResult(attempt: FeedbackAttempt) {
  const description = attempt.kind === 'import' ? 'นำเข้าสินค้า' : 'สร้างเอกสาร';
  const command = attempt.kind === 'import' ? '/upload' : '/docs';
  return {schemaVersion:1 as const,kind:attempt.kind,runId:attempt.runId,generation:attempt.generation,notificationCycle:attempt.notificationCycle,outcome:'unconfirmed' as const,messages:[{type:'text' as const,text:`⚠️ ยังยืนยันผลการ${description}ไม่ได้ กรุณาตรวจสอบก่อนส่ง ${command} ซ้ำ\n${attempt.runId}`}]};
}
