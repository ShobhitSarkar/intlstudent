'use strict';

/**
 * The automatic moderator. Every question and answer goes through `classify()` before it
 * is saved:
 *
 *   'approve' → published straight away
 *   'hold'    → saved but hidden until a moderator approves it (it lands in the moderation queue)
 *
 * This first version is rule-based: it catches harassment, scams aimed at international
 * students, spam, and contact details. It's deliberately cautious: when in doubt it holds the
 * post for a person instead of rejecting it, so a false alarm only delays a post.
 *
 * To use a trained classifier as well (e.g. a toxicity model or an LLM), add it to
 * CLASSIFIERS below: any async function taking { text, isGuest } and returning
 * { decision, reasons }. The strictest decision wins.
 */

const RULES = [
  {
    reason: 'Possible harassment or threat',
    // Phrases aimed at a person. Extend with a maintained word list before launch.
    pattern: /\b(kill (yo)?urself|kys|go die|i('| wi)ll (find|hurt|kill) you|you (stupid|worthless) (idiot|loser))\b/i,
  },
  {
    reason: 'Looks like a scam aimed at students',
    pattern: /\b(guaranteed (admission|visa|acceptance)|100% (visa|admission)|pay (for|to get) (admission|a seat|an offer)|buy (a )?(degree|diploma|offer letter)|fake (transcript|degree|offer)|visa agent fee|essay writing service|write your (essay|thesis|sop) for)\b/i,
  },
  {
    reason: 'Looks like advertising or spam',
    pattern: /\b(buy now|click here|limited offer|crypto(currency)? (investment|trading)|forex signals|earn \$?\d+ (per|a) (day|week)|work from home and earn|promo code)\b/i,
  },
  {
    reason: 'Asks to move the conversation to a messaging app',
    pattern: /\b(whats ?app|telegram|wechat|signal) (me|number|group)|\bdm me on\b/i,
  },
];

const URL_PATTERN = /\bhttps?:\/\/|www\.[a-z0-9-]+\./gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN = /(\+?\d[\d\s().-]{8,}\d)/;

function ruleClassifier({ text, isGuest }) {
  const reasons = [];
  for (const rule of RULES) if (rule.pattern.test(text)) reasons.push(rule.reason);

  const links = (text.match(URL_PATTERN) || []).length;
  // Guests can't post links at all; members can share a couple (e.g. an official page).
  if ((isGuest && links > 0) || links > 2) reasons.push(isGuest ? 'Guest post with a link' : 'Too many links');

  if (isGuest && (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text))) {
    reasons.push('Guest post with contact details');
  }

  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) reasons.push('Mostly capital letters');
  if (/(.)\1{9,}/.test(text)) reasons.push('Repeated characters');

  return { decision: reasons.length ? 'hold' : 'approve', reasons };
}

const CLASSIFIERS = [ruleClassifier];
const RANK = { approve: 0, hold: 1 };

/**
 * Check a post. `text` is everything the reader will see (title and body).
 * Returns { decision: 'approve' | 'hold', reasons: string[] }.
 */
async function classify({ text, isGuest = false }) {
  let decision = 'approve';
  const reasons = [];
  for (const classifier of CLASSIFIERS) {
    let result;
    try {
      result = await classifier({ text, isGuest });
    } catch {
      // If a classifier is unavailable, fail safe: a person reviews the post.
      result = { decision: 'hold', reasons: ['Automatic check unavailable'] };
    }
    if (RANK[result.decision] > RANK[decision]) decision = result.decision;
    reasons.push(...result.reasons);
  }
  return { decision, reasons };
}

module.exports = { classify, ruleClassifier };
