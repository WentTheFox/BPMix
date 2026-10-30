// BPMix account pages: sign in, first-run setup, enrollment, approving a device, and account/admin
// management. Plain DOM (text is always set with textContent, never as HTML) so nothing the server
// returns can inject markup; the page's CSP forbids inline scripts and any third-party origin.

const app = document.getElementById('app');
const here = new URL(location.href);
const webauthn = window.SimpleWebAuthnBrowser;

// ---------------------------------------------------------------- tiny DOM helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// (replaceChildren would render a null argument as the text "null", so drop the empty ones.)
const mount = (...nodes) => app.replaceChildren(...nodes.filter(Boolean));
const panel = (...children) => h('section', { class: 'panel' }, ...children);
const errorLine = (text) => h('p', { class: 'error', role: 'alert' }, text);
const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');

/** A form that disables its button while working and shows an error line instead of throwing. */
function form(fields, submitLabel, onSubmit) {
  const message = h('div');
  const button = h('button', { class: 'primary', type: 'submit' }, submitLabel);
  const el = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      message.replaceChildren();
      try {
        await onSubmit(Object.fromEntries(new FormData(el)));
      } catch (err) {
        message.replaceChildren(errorLine(describe(err)));
      } finally {
        button.disabled = false;
      }
    },
  }, fields, button, message);
  return el;
}

const field = (label, name, props = {}) => h('div', {}, h('label', { for: name }, label), h('input', { id: name, name, type: 'text', required: true, ...props }));

function describe(err) {
  if (err?.name === 'NotAllowedError') return 'That was cancelled.';
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- API

class ApiFailure extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, path, body) {
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: { 'X-BPMix-Api': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    // no body
  }
  if (!response.ok) {
    const message = Array.isArray(data?.message) ? data.message.join('; ') : (data?.message ?? response.statusText);
    throw new ApiFailure(response.status, message, data?.code);
  }
  return data;
}

/** Sensitive changes need a recent sign-in: send the person to do that and come back here. */
function needsFreshSignIn(err) {
  if (err instanceof ApiFailure && err.code === 'reauth_required') {
    // reauth=1: show the sign-in form even though a (stale) session exists, instead of bouncing straight back here.
    location.assign(`/login?reauth=1&next=${encodeURIComponent(location.pathname + location.search)}`);
    return true;
  }
  return false;
}

async function guarded(action) {
  try {
    return await action();
  } catch (err) {
    if (needsFreshSignIn(err)) return new Promise(() => {});
    throw err;
  }
}

async function currentUser() {
  try {
    return await api('GET', '/auth/me');
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) return null;
    throw err;
  }
}

/** Only same-site paths: this is read from the address bar and used to navigate. */
function safeNext(fallback) {
  const next = here.searchParams.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback;
}

// ---------------------------------------------------------------- sign in

function passkeysSupported() {
  return Boolean(window.PublicKeyCredential && webauthn);
}

async function signInWithPasskey() {
  const { challengeId, options } = await api('POST', '/auth/login/passkey/options', {});
  const response = await webauthn.startAuthentication({ optionsJSON: options });
  await api('POST', '/auth/login/passkey/verify', { challengeId, response });
  location.assign(safeNext('/account'));
}

function loginPage(status) {
  const passwordStep = h('div');
  const showMfa = (mfaToken) => {
    let useRecovery = false;
    const codeField = field('Authenticator code', 'code', { inputMode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxLength: 6 });
    const recoveryField = field('Recovery code', 'recoveryCode', { autocomplete: 'off' });
    const holder = h('div', {}, codeField);
    const toggle = h('button', {
      type: 'button',
      onclick: () => {
        useRecovery = !useRecovery;
        holder.replaceChildren(useRecovery ? recoveryField : codeField);
        toggle.textContent = useRecovery ? 'Use an authenticator code instead' : 'Use a recovery code instead';
      },
    }, 'Use a recovery code instead');
    passwordStep.replaceChildren(
      h('p', { class: 'muted' }, 'Enter the code from your authenticator app.'),
      form(holder, 'Sign in', async (values) => {
        await api('POST', '/auth/login/totp', { mfaToken, ...(useRecovery ? { recoveryCode: values.recoveryCode } : { code: values.code }) });
        location.assign(safeNext('/account'));
      }),
      toggle,
    );
  };
  const passwordForm = form(
    h('div', {}, field('Username', 'username', { autocomplete: 'username' }), field('Password', 'password', { type: 'password', autocomplete: 'current-password' })),
    'Continue',
    async (values) => {
      const result = await api('POST', '/auth/login/password', values);
      showMfa(result.mfaToken);
    },
  );
  passwordStep.append(passwordForm);

  mount(
    h('h1', {}, 'Sign in to BPMix'),
    panel(
      passkeysSupported()
        ? h('div', {}, h('button', { class: 'primary', type: 'button', onclick: (e) => run(e.currentTarget, signInWithPasskey) }, 'Sign in with a passkey'), h('div', { id: 'passkey-message' }))
        : h('p', { class: 'muted' }, 'This browser cannot use passkeys here (they need https, or localhost).'),
    ),
    panel(h('h2', {}, 'Use a password instead'), h('p', { class: 'muted' }, 'Passwords always need an authenticator code as well.'), passwordStep),
    status.setupRequired ? panel(h('p', {}, 'Nobody has set this server up yet. ', h('a', { href: '/setup' }, 'Create the first account'), '.')) : null,
  );
}

async function run(button, action) {
  const message = document.getElementById('passkey-message');
  button.disabled = true;
  message?.replaceChildren();
  try {
    await action();
  } catch (err) {
    message?.replaceChildren(errorLine(describe(err)));
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- first-run setup and enrollment

function setupPage(status) {
  if (!status.setupRequired) {
    mount(h('h1', {}, 'Already set up'), panel(h('p', {}, 'This server already has its first account. Ask an admin to create one for you, or ', h('a', { href: '/login' }, 'sign in'), '.')));
    return;
  }
  mount(
    h('h1', {}, 'Welcome to BPMix'),
    panel(
      h('h2', {}, 'Create the first account'),
      h('p', { class: 'muted' }, 'It becomes the administrator. After this, only an admin can add people.'),
      form(
        h('div', {}, field('Username', 'username', { autocomplete: 'username' }), field('Display name', 'displayName', { autocomplete: 'name' }), status.setupTokenRequired ? field('Setup token (printed in the server log when it started)', 'setupToken', { autocomplete: 'off' }) : null),
        'Continue',
        async (values) => {
          const me = await api('POST', '/auth/setup', values);
          enrollmentPage(me, '/account');
        },
      ),
    ),
  );
}

async function enrollPage() {
  const token = here.searchParams.get('token');
  if (!token) {
    mount(h('h1', {}, 'Enrollment link'), panel(errorLine('This link is missing its token. Ask the admin for a new one.')));
    return;
  }
  // Take the token out of the address bar (and history) as soon as it has been read.
  history.replaceState(null, '', '/enroll');
  try {
    const me = await api('POST', '/auth/invites/redeem', { inviteToken: token });
    enrollmentPage(me, '/account');
  } catch (err) {
    mount(h('h1', {}, 'Enrollment link'), panel(errorLine(describe(err)), h('p', { class: 'muted' }, 'Links work once and expire after a week. Ask the admin for a new one.')));
  }
}

/** "Choose how you will sign in" - used right after setup and an invite, and from the account page. */
function enrollmentPage(me, doneHref) {
  const body = h('div');
  const finish = () => location.assign(doneHref);
  const choose = () =>
    body.replaceChildren(
      h('p', {}, `Hi ${me.displayName}. Choose how you want to sign in next time. You can add the other later.`),
      passkeysSupported() ? h('button', { class: 'primary', type: 'button', onclick: addPasskeyFlow }, 'Use a passkey (recommended)') : h('p', { class: 'muted' }, 'Passkeys are not available in this browser.'),
      h('button', { type: 'button', onclick: passwordFlow }, 'Use a password and an authenticator app'),
    );
  const addPasskeyFlow = async () => {
    body.replaceChildren(h('p', { class: 'muted' }, 'Follow your device’s prompt…'));
    try {
      await guarded(() => registerPasskey());
      finish();
    } catch (err) {
      choose();
      body.append(errorLine(describe(err)));
    }
  };
  const passwordFlow = () => passwordSetup(body, finish, choose);
  mount(h('h1', {}, 'Set up how you sign in'), panel(body));
  choose();
}

async function registerPasskey(name) {
  const optionsJSON = await api('POST', '/auth/passkeys/register/options', {});
  const response = await webauthn.startRegistration({ optionsJSON });
  return api('POST', '/auth/passkeys/register/verify', { response, ...(name ? { name } : {}) });
}

function passwordSetup(body, finish, back) {
  body.replaceChildren(
    h('h2', {}, 'Password and authenticator app'),
    form(
      h('div', {}, field('Password (12 or more characters)', 'password', { type: 'password', autocomplete: 'new-password', minLength: 12 }), field('Repeat password', 'again', { type: 'password', autocomplete: 'new-password' })),
      'Continue',
      async (values) => {
        if (values.password !== values.again) throw new Error('The passwords do not match.');
        await guarded(() => api('POST', '/auth/password', { password: values.password }));
        const setup = await guarded(() => api('POST', '/auth/totp/begin', {}));
        authenticatorStep(body, setup, finish);
      },
    ),
    h('button', { type: 'button', onclick: back }, 'Back'),
  );
}

function authenticatorStep(body, setup, finish) {
  body.replaceChildren(
    h('h2', {}, 'Add it to your authenticator app'),
    h('p', { class: 'muted' }, 'Open your authenticator app and add an account with this key (or open the link on a phone that has one):'),
    h('code', { class: 'bigcode' }, setup.secret.replace(/(.{4})/g, '$1 ').trim()),
    h('p', {}, h('a', { href: setup.otpauthUri }, 'Open in authenticator app')),
    form(field('Code from the app', 'code', { inputMode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxLength: 6 }), 'Turn on', async (values) => {
      const { recoveryCodes } = await guarded(() => api('POST', '/auth/totp/enable', { code: values.code }));
      recoveryCodesStep(body, recoveryCodes, finish);
    }),
  );
}

function recoveryCodesStep(body, codes, finish) {
  if (codes.length === 0) {
    finish();
    return;
  }
  body.replaceChildren(
    h('h2', {}, 'Save your recovery codes'),
    h('p', {}, 'If you lose your authenticator app, each of these signs you in once. They are shown only now — keep them somewhere safe.'),
    h('ul', { class: 'codes' }, codes.map((code) => h('li', {}, code))),
    h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(codes.join('\n')) }, 'Copy'),
    h('button', { class: 'primary', type: 'button', onclick: finish }, 'I have saved them'),
  );
}

// ---------------------------------------------------------------- approving a device

async function devicePage(me) {
  if (!me) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }
  const result = h('div');
  const input = h('input', { id: 'userCode', name: 'userCode', type: 'text', required: true, autocomplete: 'off', value: here.searchParams.get('code') ?? '', placeholder: 'ABCD-EFGH' });
  const decide = async (userCode, approve) => {
    try {
      await guarded(() => api('POST', '/auth/device/approve', { userCode, approve }));
      result.replaceChildren(h('p', { class: approve ? 'ok' : 'muted' }, approve ? 'Approved. You can go back to the app.' : 'Denied.'));
    } catch (err) {
      result.replaceChildren(errorLine(describe(err)));
    }
  };
  const lookup = async () => {
    result.replaceChildren();
    try {
      const code = input.value.trim();
      const found = await api('GET', `/auth/device/lookup?userCode=${encodeURIComponent(code)}`);
      result.replaceChildren(
        h('p', {}, h('strong', {}, found.deviceName), ' wants to sign in as ', h('strong', {}, me.displayName), '.'),
        h('p', { class: 'muted' }, 'Only approve if you just started this on your own device and the code matches.'),
        h('button', { class: 'primary', type: 'button', onclick: () => decide(code, true) }, 'Approve'),
        h('button', { class: 'danger', type: 'button', onclick: () => decide(code, false) }, 'Deny'),
      );
    } catch (err) {
      result.replaceChildren(errorLine(describe(err)));
    }
  };
  mount(
    h('h1', {}, 'Sign in a device'),
    panel(h('label', { for: 'userCode' }, 'Code shown in the app'), input, h('button', { class: 'primary', type: 'button', onclick: lookup }, 'Continue'), result),
  );
  if (input.value) await lookup();
}

// ---------------------------------------------------------------- account management

async function accountPage(me) {
  if (!me) {
    location.assign(`/login?next=${encodeURIComponent('/account')}`);
    return;
  }
  if (!me.enrolled) {
    enrollmentPage(me, '/account');
    return;
  }
  const sections = h('div');
  mount(
    h('h1', {}, me.displayName),
    h('p', { class: 'muted' }, `@${me.username} · ${me.role === 'ADMIN' ? 'administrator' : 'member'}`),
    h('nav', {}, h('a', { href: '/' }, 'Open BPMix'), h('button', { type: 'button', onclick: signOut }, 'Sign out')),
    sections,
  );
  const reload = async () => {
    const fresh = await api('GET', '/auth/me');
    const parts = [methodsSection(fresh, reload), await devicesSection(reload), await sessionsSection(reload)];
    if (fresh.role === 'ADMIN') parts.push(await usersSection(reload), await scanSection(reload));
    sections.replaceChildren(...parts);
  };
  await reload();
}

async function signOut() {
  await api('POST', '/auth/logout', {}).catch(() => undefined);
  location.assign('/login');
}

/** Wraps a button action: reports failures in the section instead of throwing, and refreshes on success. */
function action(label, work, reload, props = {}) {
  const message = h('span');
  const button = h('button', { type: 'button', ...props, onclick: async () => {
    button.disabled = true;
    message.replaceChildren();
    try {
      await guarded(work);
      await reload();
    } catch (err) {
      message.replaceChildren(errorLine(describe(err)));
      button.disabled = false;
    }
  } }, label);
  return h('span', {}, button, message);
}

function methodsSection(me, reload) {
  const addPasskey = action('Add a passkey', () => registerPasskey(), reload);
  return panel(
    h('h2', {}, 'Ways to sign in'),
    h('h3', {}, 'Passkeys'),
    me.passkeys.length === 0 ? h('p', { class: 'muted' }, 'None yet.') : null,
    me.passkeys.map((p) =>
      h('div', { class: 'row' },
        h('div', {}, p.name, p.backedUp ? h('span', { class: 'tag' }, 'synced') : null, h('div', { class: 'muted' }, `Added ${when(p.createdAtMs)} · last used ${when(p.lastUsedAtMs)}`)),
        action('Remove', () => api('DELETE', `/auth/passkeys/${encodeURIComponent(p.id)}`), reload, { class: 'danger' }),
      ),
    ),
    passkeysSupported() ? addPasskey : h('p', { class: 'muted' }, 'This browser cannot add passkeys here.'),
    h('h3', {}, 'Password and authenticator app'),
    h('p', { class: 'muted' }, me.hasPassword && me.totpEnabled ? `On. ${me.recoveryCodesRemaining} recovery code(s) left.` : 'Off.'),
    me.hasPassword && me.totpEnabled ? recoveryCodesAction(reload) : h('button', { type: 'button', onclick: () => passwordSetupInPlace() }, 'Set up a password and authenticator app'),
  );
}

function passwordSetupInPlace() {
  const body = h('div');
  mount(h('h1', {}, 'Password and authenticator app'), panel(body));
  passwordSetup(body, () => location.assign('/account'), () => location.assign('/account'));
}

function recoveryCodesAction(reload) {
  const shown = h('div');
  const button = action('Make new recovery codes', async () => {
    const { recoveryCodes } = await api('POST', '/auth/recovery-codes', {});
    shown.replaceChildren(h('p', {}, 'Your new codes (the old ones no longer work):'), h('ul', { class: 'codes' }, recoveryCodes.map((c) => h('li', {}, c))));
  }, async () => undefined);
  return h('div', {}, button, shown);
}

async function devicesSection(reload) {
  const devices = await api('GET', '/auth/devices');
  return panel(
    h('h2', {}, 'Signed-in apps'),
    devices.length === 0 ? h('p', { class: 'muted' }, 'No apps are signed in. In an app, choose to sign in with a code, then enter it ', h('a', { href: '/device' }, 'here'), '.') : null,
    devices.map((d) =>
      h('div', { class: 'row' }, h('div', {}, d.name, h('div', { class: 'muted' }, `Added ${when(d.createdAtMs)} · last used ${when(d.lastUsedAtMs)}`)), action('Sign out', () => api('DELETE', `/auth/devices/${d.id}`), reload, { class: 'danger' })),
    ),
  );
}

async function sessionsSection(reload) {
  const sessions = await api('GET', '/auth/sessions');
  return panel(
    h('h2', {}, 'Browsers'),
    sessions.map((s) =>
      h('div', { class: 'row' },
        h('div', {}, (s.userAgent ?? 'Unknown browser').slice(0, 90), s.current ? h('span', { class: 'tag' }, 'this browser') : null, h('div', { class: 'muted' }, `${s.ip ?? ''} · last seen ${when(s.lastSeenAtMs)}`)),
        s.current ? null : action('Sign out', () => api('DELETE', `/auth/sessions/${encodeURIComponent(s.id)}`), reload, { class: 'danger' }),
      ),
    ),
  );
}

async function usersSection(reload) {
  const users = await api('GET', '/users');
  const link = h('div');
  const showLink = (invite, name) => {
    const url = `${location.origin}/enroll?token=${invite.inviteToken}`;
    link.replaceChildren(
      h('p', {}, `Send this link to ${name}. It works once and expires ${when(invite.expiresAtMs)}:`),
      h('p', {}, h('code', {}, url)),
      h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(url) }, 'Copy link'),
    );
  };
  return panel(
    h('h2', {}, 'People'),
    users.map((u) =>
      h('div', { class: 'row' },
        h('div', {}, u.displayName, h('span', { class: 'tag' }, u.role === 'ADMIN' ? 'admin' : 'member'), u.disabled ? h('span', { class: 'tag' }, 'disabled') : null, !u.enrolled && !u.disabled ? h('span', { class: 'tag' }, 'waiting to set up') : null, h('div', { class: 'muted' }, `@${u.username}`)),
        h('div', {},
          action('New link', async () => showLink(await api('POST', `/users/${u.id}/invite`, {}), u.displayName), async () => undefined),
          action(u.disabled ? 'Enable' : 'Disable', () => api('PATCH', `/users/${u.id}`, { disabled: !u.disabled }), reload),
          action(u.role === 'ADMIN' ? 'Make member' : 'Make admin', () => api('PATCH', `/users/${u.id}`, { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' }), reload),
        ),
      ),
    ),
    h('h3', {}, 'Add someone'),
    form(h('div', {}, field('Username', 'username'), field('Display name', 'displayName'), h('label', { for: 'role' }, 'Role'), h('select', { id: 'role', name: 'role' }, h('option', { value: 'USER' }, 'Member'), h('option', { value: 'ADMIN' }, 'Administrator'))), 'Create', async (values) => {
      const created = await guarded(() => api('POST', '/users', values));
      await reload();
      showLink(created.invite, created.user.displayName);
    }),
    link,
  );
}

async function scanSection(reload) {
  const status = await api('GET', '/scan');
  const skipped = status.jobs.skipped > 0 ? await api('GET', '/scan/jobs?state=SKIPPED&limit=20') : { items: [] };
  const last = status.last;
  return panel(
    h('h2', {}, 'Library scanning'),
    h('p', { class: 'muted' }, status.running ? 'Scanning now…' : last ? `Last scan ${when(last.finishedAtMs)}: ${last.tracks} tracks.` : 'No scan has finished yet.'),
    h('p', { class: 'muted' }, `${status.jobs.done} processed · ${status.jobs.pending} waiting${status.jobs.retrying ? ` (${status.jobs.retrying} retrying)` : ''} · ${status.jobs.skipped} skipped`),
    action('Scan now', () => api('POST', '/scan', {}), reload),
    skipped.items.length > 0
      ? h('div', {}, h('h3', {}, 'Skipped files'), h('p', { class: 'muted' }, 'These failed every attempt and are left alone until they change.'),
          skipped.items.map((j) => h('div', { class: 'row' }, h('div', {}, j.relativePath ?? '(removed)', h('div', { class: 'muted' }, `${j.lastErrorStage ?? ''}: ${(j.lastError ?? '').slice(0, 160)}`))),
          ), action('Try them again', () => api('POST', '/scan/retry', {}), reload))
      : null,
  );
}

// ---------------------------------------------------------------- start

async function boot() {
  const status = await api('GET', '/auth/status');
  const me = await currentUser();
  switch (here.pathname.replace(/\/+$/, '') || '/') {
    case '/setup':
      return setupPage(status);
    case '/login':
      // Already signed in -> nothing to do here, unless this visit is a request to sign in again.
      return me?.enrolled && !here.searchParams.has('reauth') ? location.assign(safeNext('/account')) : loginPage(status);
    case '/enroll':
      return enrollPage();
    case '/device':
      return devicePage(me);
    default:
      return accountPage(me);
  }
}

boot().catch((err) => mount(h('h1', {}, 'Something went wrong'), panel(errorLine(describe(err)), h('p', { class: 'muted' }, 'Is the server reachable?'))));
