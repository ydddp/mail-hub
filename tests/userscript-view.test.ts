import { describe, expect, it } from 'vitest';
import { capsuleFor, drawerPlan, resultShape, stageOf } from '../userscript/src/view.js';
import type { CapsuleInput, Stage } from '../userscript/src/view.js';
import type { Phase } from '../userscript/src/storage.js';

/**
 * The panel renders only what these functions derive. Each row is a state the
 * user can reach; a regression here is a panel that shows the wrong thing or
 * offers the wrong next step.
 */

describe('stageOf', () => {
  const cases: Array<[string, { phase: Phase; hasInbox: boolean; reported?: boolean; hasResult?: boolean }, Stage]> = [
    ['nothing yet', { phase: 'idle', hasInbox: false }, 'empty'],
    ['creating the first inbox', { phase: 'creating', hasInbox: false }, 'creating'],
    // A replacement create keeps the old inbox on record until the new one exists.
    ['creating while an old inbox is on record', { phase: 'creating', hasInbox: true }, 'creating'],
    ['create outcome unknown', { phase: 'create-unknown', hasInbox: true }, 'create-unknown'],
    // A failed create restores the previous phase: the old closed inbox, which
    // the panel then shows together with the error notice.
    ['create failed after a closed inbox', { phase: 'closed', hasInbox: true }, 'closed'],
    ['polling, no mail', { phase: 'polling', hasInbox: true }, 'waiting'],
    ['mail arrived', { phase: 'result', hasInbox: true, hasResult: true }, 'result'],
    // After a navigation the result may be gone from memory; never claim one.
    ['result phase restored without the result', { phase: 'result', hasInbox: true, hasResult: false }, 'waiting'],
    ['reported, still receiving', { phase: 'reported', hasInbox: true, reported: true }, 'reported'],
    ['a new message after reporting keeps the reported stage', { phase: 'result', hasInbox: true, reported: true, hasResult: true }, 'reported'],
    ['reporting', { phase: 'reporting', hasInbox: true }, 'reporting'],
    ['report outcome unknown', { phase: 'report-unknown', hasInbox: true }, 'report-unknown'],
    ['closing', { phase: 'closing', hasInbox: true, reported: true }, 'closing'],
    ['close failed', { phase: 'close-failed', hasInbox: true }, 'close-failed'],
    ['closed', { phase: 'closed', hasInbox: true, reported: true }, 'closed'],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(stageOf({ reported: false, hasResult: false, ...input })).toBe(expected);
  });
});

describe('resultShape', () => {
  const link = { url: 'https://github.com/confirm?t=1', domain: 'github.com' };
  it.each([
    ['one code', { candidates: [{ value: '482913' }], link: null, subject: 's' }, { kind: 'code', value: '482913', link: null }],
    ['code and link: the code leads, the link rides along', { candidates: [{ value: '771204' }], link, subject: 's' }, { kind: 'code', value: '771204', link }],
    ['link only', { candidates: [], link, subject: 's' }, { kind: 'link', link }],
    // Never pick the "best" of several numbers on the user's behalf.
    ['several codes', { candidates: [{ value: '482913' }, { value: '2026' }], link: null, subject: 's' }, { kind: 'choose', count: 2 }],
    ['nothing extracted', { candidates: [], link: null, subject: 'Welcome' }, { kind: 'message', subject: 'Welcome' }],
  ] as const)('%s', (_name, input, expected) => {
    expect(resultShape({ ...input, candidates: [...input.candidates] })).toEqual(expected);
  });
});

describe('capsuleFor', () => {
  const base: CapsuleInput = {
    stage: 'waiting', address: 'kestrel@outlook.com', service: 'example.com',
    result: null, addressUsed: false, resultUsed: false, notice: null, providerLabel: '自动分配',
  };
  const code = { kind: 'code', value: '482913', link: null } as const;
  const link = { kind: 'link', link: { url: 'https://github.com/x', domain: 'github.com' } } as const;

  it.each<[string, Partial<CapsuleInput>, { value: string; action: string | null; busy?: boolean; drawer?: boolean }]>([
    // Says what the button will do: which site, which provider (in the status).
    ['empty with a service offers to get one', { stage: 'empty', address: null }, { value: 'example.com', action: 'get' }],
    ['empty without a service asks for one in the drawer', { stage: 'empty', address: null, service: null }, { value: '认不出当前网站', action: null, drawer: true }],
    ['creating is busy, not clickable again', { stage: 'creating', address: null }, { value: '还没有邮箱', action: 'get', busy: true }],
    ['replacing keeps the old address, muted', { stage: 'creating' }, { value: 'kestrel@outlook.com', action: 'get', busy: true }],
    ['waiting raises the address with fill', { stage: 'waiting' }, { value: 'kestrel@outlook.com', action: 'fill-address' }],
    ['a code raises the code with fill', { stage: 'result', result: code }, { value: '482913', action: 'fill-code' }],
    ['code and link: the code leads', { stage: 'result', result: { ...code, link: { url: 'https://x.test/v', domain: 'x.test' } } }, { value: '482913', action: 'fill-code' }],
    ['a used code moves the primary to finishing', { stage: 'result', result: code, resultUsed: true }, { value: '482913', action: 'finish' }],
    ['a link raises its domain and opens', { stage: 'result', result: link }, { value: 'github.com', action: 'open-link' }],
    ['several codes need the drawer', { stage: 'result', result: { kind: 'choose', count: 3 } }, { value: '3 个候选码', action: 'choose', drawer: true }],
    ['mail without a code offers to read it', { stage: 'result', result: { kind: 'message', subject: 'Welcome' } }, { value: 'Welcome', action: 'view-message' }],
    ['reporting is busy', { stage: 'reporting', result: code }, { value: '482913', action: 'finish', busy: true }],
    ['reported keeps receiving, ending is next', { stage: 'reported', result: code }, { value: '482913', action: 'end' }],
    // A report that may have counted is never offered again.
    ['report outcome unknown only offers ending', { stage: 'report-unknown', result: code }, { value: '482913', action: 'end' }],
    ['close failed offers a retry', { stage: 'close-failed' }, { value: 'kestrel@outlook.com', action: 'retry-close' }],
    // Closed is a result, not a dead button: the next step is a new inbox.
    ['closed offers a new inbox, old address muted', { stage: 'closed' }, { value: 'kestrel@outlook.com', action: 'get' }],
  ])('%s', (_name, patch, expected) => {
    const capsule = capsuleFor({ ...base, ...patch });
    expect(capsule.value.text).toBe(expected.value);
    expect(capsule.primary?.action ?? null).toBe(expected.action);
    expect(capsule.primary?.busy ?? false).toBe(expected.busy ?? false);
    expect(capsule.needsDrawer).toBe(expected.drawer ?? false);
  });

  it('a link that came with a code stays reachable from the capsule', () => {
    const link = { url: 'https://x.test/v', domain: 'x.test' };
    expect(capsuleFor({ ...base, stage: 'result', result: { kind: 'code', value: '1', link } }).link).toEqual(link);
    expect(capsuleFor({ ...base, stage: 'result', result: code }).link).toBeNull();
  });

  it('a notice replaces the status but keeps the next step', () => {
    // The regression this locks: a failed create used to render the old closed
    // inbox with no error at all.
    const capsule = capsuleFor({ ...base, stage: 'closed', notice: { text: '上游提供商故障', tone: 'error' } });
    expect(capsule.status).toBe('上游提供商故障');
    expect(capsule.tone).toBe('error');
    expect(capsule.primary?.action).toBe('get');
  });
});

describe('drawerPlan', () => {
  it.each<[Stage, boolean, boolean, Partial<ReturnType<typeof drawerPlan>>]>([
    ['empty', false, false, { providerEditable: true, showAddress: false, finish: 'none', canReplace: false }],
    ['waiting', false, true, { providerEditable: false, addressFill: true, canContinue: false, finish: 'full', canReplace: true }],
    ['result', true, false, { addressFill: true, canContinue: true, finish: 'full' }],
    // Continuing on a closed inbox was offered before; it must not be.
    ['closed', true, false, { providerEditable: true, addressFill: false, canContinue: false, finish: 'none', canReplace: false }],
    ['reported', true, false, { finish: 'end-only', canContinue: true }],
    ['reporting', true, false, { addressFill: false, canContinue: false, finish: 'none', canReplace: false }],
    ['close-failed', false, false, { finish: 'end-only' }],
  ])('%s', (stage, hasResult, waiting, expected) => {
    expect(drawerPlan(stage, hasResult, waiting)).toMatchObject(expected);
  });
});
