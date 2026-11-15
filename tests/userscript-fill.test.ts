import { describe, expect, it } from 'vitest';
import { pickField } from '../userscript/src/fill.js';
import type { FieldInfo, FillKind } from '../userscript/src/fill.js';

/**
 * "填入" writes into the page without the user pointing at a field, so a wrong
 * pick types an address into a password or a code into a phone number. Each
 * row is a form shape seen on real signup pages; the expected index is the
 * field a person would have chosen, or -1 when the honest answer is "copy it
 * instead".
 */

function field(patch: Partial<FieldInfo>): FieldInfo {
  return {
    type: 'text', autocomplete: '', text: '', inputMode: '', maxLength: -1, hasValue: false, recent: false, splitRow: false, ...patch,
  };
}

const name = field({ text: 'name display name', autocomplete: 'name' });
const email = field({ type: 'email', text: 'email you@example.com', autocomplete: 'email' });
const password = field({ type: 'password', text: 'password' });
const otp = field({ text: 'verification_code verification code', autocomplete: 'one-time-code', inputMode: 'numeric' });
const phone = field({ type: 'tel', text: 'phone mobile number' });
const promo = field({ text: 'promo code', maxLength: 8 });

describe('pickField', () => {
  it.each<[string, FillKind, FieldInfo[], number]>([
    ['typed email field', 'email', [name, email, password], 1],
    ['email by label only', 'email', [name, field({ text: 'f1 your e-mail' }), password], 1],
    ['Chinese label', 'email', [field({ text: '昵称' }), field({ text: '邮箱地址' })], 1],
    ['a lone username field is not enough to guess', 'email', [field({ text: 'username', autocomplete: 'username' }), password], -1],
    ['never into a password', 'email', [password], -1],
    // A login page with no email field must not receive the address in "name".
    ['no email-like field means copy instead', 'email', [name, password], -1],
    ['never into the code field', 'email', [otp], -1],
    ['one-time-code autocomplete', 'code', [email, otp, password], 1],
    ['code by placeholder and length', 'code', [field({ text: 'f4 code from the e-mail', inputMode: 'numeric', maxLength: 6 })], 0],
    ['split boxes count as a code field', 'code', [field({ text: 'digit 1', maxLength: 1, inputMode: 'numeric', splitRow: true })], 0],
    ['a lone one-character box is not', 'code', [field({ text: 'initial', maxLength: 1 })], -1],
    ['never into a phone number', 'code', [phone], -1],
    ['promo code is not a verification code', 'code', [promo, otp], 1],
    ['never into the email field', 'code', [email], -1],
    // Between two plausible fields, the one the user was last typing in wins.
    ['recent caret breaks a tie', 'email', [field({ type: 'email' }), field({ type: 'email', recent: true })], 1],
    ['an empty field beats a filled one', 'email', [field({ type: 'email', hasValue: true }), field({ type: 'email' })], 1],
  ])('%s', (_name, kind, fields, expected) => {
    expect(pickField(kind, fields)).toBe(expected);
  });
});
