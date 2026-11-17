/** Exact Hub-issued question identity. Text never supplies authority. */
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export const validConversationTarget = value => value != null && !Array.isArray(value)
  && Object.keys(value).length === 3 && ['run_id', 'assignment_id', 'question_request_id'].every(key => validId(value[key]))
export const sameConversationTarget = (a, b) => a == null && b == null || validConversationTarget(a) && validConversationTarget(b)
  && ['run_id', 'assignment_id', 'question_request_id'].every(key => a[key] === b[key])
export const conversationTarget = row => ({ run_id: row.run_id, assignment_id: row.assignment_id, question_request_id: row.question_request_id })
export const conversationTargetKey = row => row ? JSON.stringify([row.run_id, row.assignment_id, row.question_request_id]) : ''
export function validateConversationQuestions(team, result) {
  if (result?.home_hub !== team.home_hub || result.team_id !== team.id || result.conversation_id !== team.conversation_id
    || !Array.isArray(result.items) || result.items.some(row => !validConversationTarget(conversationTarget(row))
      || typeof row.run_title !== 'string' || !Array.isArray(row.questions) || !row.questions.length
      || row.questions.some(question => typeof question?.id !== 'string' || typeof question.question !== 'string'
        || (question.options != null && (!Array.isArray(question.options) || question.options.some(option => typeof option?.label !== 'string' || (option.description != null && typeof option.description !== 'string'))))))
    || new Set(result.items.map(conversationTargetKey)).size !== result.items.length) throw Error('问题列表与当前对话不匹配，请重新读取。')
  return result.items
}
