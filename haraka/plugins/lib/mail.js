'use strict'
// Shared message-shape predicates.

// A bounce message (NDR) carries the null return-path, `<>`: RFC 5321 requires
// it so that a bounce which cannot itself be delivered has nobody to bounce to
// and the chain terminates. Core relies on the same test in bounce_respond()
// before treating a failed NDR as a double bounce.
//
// Defaults to false when the envelope cannot be read: mistaking customer mail
// for an NDR would route it away from the upstream and skip dead-letter
// custody, so unknown shapes must take the safe (customer-mail) path.
function isBounceMessage(hmail) {
  const mail_from = hmail && hmail.todo && hmail.todo.mail_from
  return Boolean(mail_from) && !mail_from.user
}

module.exports = { isBounceMessage }
