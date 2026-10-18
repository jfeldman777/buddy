// Compatibility shim (step 5 → 6). Prefer disputes.js.
export {
  createTeachRuling,
  createTeachDispute,
  listTeachRulings,
  listTeachDisputes,
  formatRulingsForExaminer,
  formatDisputesForExaminer,
  getTeachDispute,
  addDisputeCreatorMessage,
  discussDisputeWithBi,
  resolveTeachDispute,
  __test,
} from './disputes.js';
