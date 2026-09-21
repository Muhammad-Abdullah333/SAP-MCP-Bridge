'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name=bridge-token]').content;
let state = { connections: [] },
  selected = '';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
}
applyTheme('system');
systemTheme.addEventListener('change', () => {
  if ($('theme').value === 'system') applyTheme('system');
});
$('theme').onchange = async () => {
  const theme = $('theme').value;
  applyTheme(theme);
  try {
    await call('/api/preferences', 'POST', { theme });
  } catch (error) {
    notify('Theme changed, but could not save preference: ' + error.message, true);
  }
};
call('/api/preferences')
  .then(p => {
    $('theme').value = p.theme;
    applyTheme(p.theme);
    $('welcome').hidden = Boolean(p.setupSeen);
  })
  .catch(error => notify('Could not load theme preference: ' + error.message, true, false));

async function call(route, method = 'GET', data) {
  const response = await fetch(route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
    body: data ? JSON.stringify(data) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value;
}
function notify(message, error = false, record = true) {
  if (record) addLog(message, error);
  if (error) {
    const help = explainError(message);
    $('error-help-text').textContent = help.message;
    $('error-help').hidden = false;
    $('error-guide').onclick = () => {
      showView('guide');
      document.getElementById(help.section).scrollIntoView();
    };
    message = help.message;
  }
  const status = $('status');
  status.textContent = message;
  status.className = `show${error ? ' error' : ''}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (status.className = ''), 6000);
}
const POLICY_LISTS = ['allowedPackages', 'allowedTables', 'allowedTools', 'allowedTransports', 'deniedTables', 'deniedTools'];
function policyValues() {
  const policy = { level: policyLevel, readLevel: policyReadLevel };
  for (const key of POLICY_LISTS) policy[key] = $(key).value;
  return policy;
}
function setPolicy(policy) {
  // The level is read back from the whole policy, so a stored record, a legacy one and
  // an imported backup all land on the right stop without the form having to guess.
  policyLevel = policy?.readOnly ? 0 : policy?.customOnly ? 1 : 2;
  policyReadLevel = policy?.allowFreeSql === false ? 0 : 1;
  // Entries loaded from a saved policy belong to the user, so none count as added here.
  autoDenied = [];
  announceNext = false;
  // One entry per line: a wildcard list is read far more easily down the page than across it.
  for (const key of POLICY_LISTS) $(key).value = (policy?.[key] || []).join('\n');
  describePolicy();
}
let policyPreview = Promise.resolve();
// The chosen level is held here. The rating is worked out by the manager from the whole
// policy and shown for a few seconds when something changes.
let policyLevel = 0;
// A new connection starts on the safer reading choice, matching the server-side default
// for a connection that arrives without a policy.
let policyReadLevel = 0;
let announceNext = false;
function setPolicyLevel(level) {
  policyLevel = Math.max(0, Math.min(2, level));
  applyMiddleLevelDenials();
  announceNext = true;
  describePolicy();
}
// The middle level confines changes to custom objects, but the debugger and abapGit act
// on something other than an object, and code the AI runs acts with the account's own
// authorisations, so the namespace check never weighs any of them. Choosing the middle
// level therefore denies them, as ordinary list entries the user can see and remove.
// Unit tests stay allowed, because they are how the AI checks its own work; the form
// names them instead. Leaving the level takes back only what was added here.
const MIDDLE_LEVEL_DENIALS = ['toolset:debugger', 'toolset:git', 'runSnippet', 'runClass'];
let autoDenied = [];
function applyMiddleLevelDenials() {
  const field = $('deniedTools');
  const lines = field.value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const listed = entry => lines.some(line => line.toLowerCase() === entry.toLowerCase());
  if (policyLevel === 1) {
    const added = MIDDLE_LEVEL_DENIALS.filter(entry => !listed(entry));
    if (!added.length) return;
    field.value = [...lines, ...added].join('\n');
    autoDenied = [...autoDenied, ...added];
  } else if (autoDenied.length) {
    field.value = lines.filter(line => !autoDenied.some(entry => entry.toLowerCase() === line.toLowerCase())).join('\n');
    autoDenied = [];
  }
}
function setPolicyReadLevel(level) {
  policyReadLevel = Math.max(0, Math.min(1, level));
  announceNext = true;
  describePolicy();
}
// The choices are built from what the manager reports, so their wording cannot drift from
// the rules actually being applied.
function renderChoices(boxId, group, levels, onPick) {
  const box = $(boxId);
  if (box.childElementCount === levels.length) return;
  box.replaceChildren();
  for (const level of levels) {
    const choice = document.createElement('label');
    choice.className = 'policy-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = String(level.level);
    input.onchange = () => onPick(level.level);
    const text = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = level.name;
    const detail = document.createElement('small');
    detail.textContent = level.detail;
    text.append(name, detail);
    choice.append(input, text);
    box.append(choice);
  }
}
// Shown for a few seconds rather than sitting on the form permanently, so the page stays
// quiet while a connection is being filled in.
function announceRisk(result) {
  const status = $('status');
  status.textContent = result.name + ' \u00b7 ' + result.rating + ' risk';
  status.className = 'show risk-' + result.tone;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (status.className = ''), 6000);
}
function describePolicy() {
  // Ask the manager where this policy actually stands. The rules live in one place, and
  // the reading comes from the whole policy: an allowed-packages list of Z* confines
  // changes to the customer namespace whatever was picked, so the choice shown is the
  // level really in force rather than the one that was asked for.
  policyPreview = policyPreview
    .then(() => call('/api/policy-preview', 'POST', { policy: policyValues() }))
    .then(result => {
      renderChoices('policy-levels', 'policy-level', result.levels || [], setPolicyLevel);
      renderChoices('policy-read-levels', 'policy-read-level', result.readLevels || [], setPolicyReadLevel);
      for (const [boxId, value] of [['policy-levels', result.level], ['policy-read-levels', result.readLevel]]) {
        const chosen = $(boxId).querySelector('input[value="' + value + '"]');
        if (chosen) chosen.checked = true;
      }
      $('policy-level-note').textContent = (result.notes || []).join(' ');
      if (announceNext) announceRisk(result);
      announceNext = false;
      renderPolicyWarnings(result.warnings);
    })
    .catch(error => renderPolicyWarnings([error.message]));
  return policyPreview;
}
function renderPolicyWarnings(messages) {
  const box = $('policy-warnings');
  box.replaceChildren();
  for (const message of messages || []) {
    const line = document.createElement('p');
    line.textContent = message;
    box.append(line);
  }
}


function values() {
  return {
    isNew: !selected,
    originalId: selected || undefined,
    id: $('id').value,
    url: $('url').value,
    client: $('client').value,
    user: $('user').value,
    password: $('password').value,
    ca: $('ca').value,
    servername: $('servername').value,
    authType: $('authType').value,
    enabled: $('enabled').checked,
    default: $('default').checked,
    insecureTls: $('insecureTls').checked,
    policy: policyValues(),
    oauth: { tokenUrl: $('oauth-token').value, clientId: $('oauth-id').value, scope: $('oauth-scope').value },
    oauthClientSecret: $('oauth-secret').value,
    sso2: {
      command: $('sso2-command').value,
      args: JSON.parse($('sso2-args').value || '[]'),
      timeoutMs: Number($('sso2-timeout').value || 30000),
    },
  };
}
function updateAuth() {
  const auth = $('authType').value;
  $('oauth-fields').hidden = auth !== 'oauth';
  $('sso2-fields').hidden = auth !== 'sso2';
  $('sso-help').hidden = auth !== 'sso';
  $('user').required = auth === 'basic';
}
function updateSecurity() {
  $('tls-warning').hidden = !$('insecureTls').checked;
  const certificate = $('ca').value.trim();
  // One field holds the certificate, and the button fills it in. An empty field is the
  // normal case rather than something missing, so it says what it actually means: the
  // trusted certificates this computer already has are the ones being used.
  $('certificate-name').textContent = certificate ? 'Using ' + certificate.split(/[\\/]/).pop() : 'Using the system’s trusted certificates';
  $('clear-certificate').hidden = !certificate;
}
// One connection is the default: the system the AI uses when a request does not name
// one. Saving enforces that (ticking Default here clears it everywhere else, and a
// disabled connection cannot hold it), so the checkboxes show the same rule rather than
// letting a tick be taken back silently on save.
function updateFlags() {
  const current = state.connections.find(c => c.id === selected);
  const isDefault = Boolean(current?.default);
  const enabled = $('enabled').checked;
  if (!enabled) $('default').checked = false;
  else if (isDefault) $('default').checked = true;
  // The default is moved, not removed: it can only be given to another connection.
  $('default').disabled = !enabled || isDefault;
  const holder = state.connections.find(c => c.default && c.id !== selected);
  $('default-note').textContent = !enabled
    ? 'A disabled connection cannot be the default.' + (isDefault ? ' Another enabled connection takes over when you save.' : '')
    : isDefault
      ? 'The AI uses this system when a request does not name one. To change that, tick Default on another connection.'
      : 'Default: the system the AI uses when a request does not name one.' + (holder ? ' Ticking it here replaces ' + holder.id + '.' : '');
}
$('enabled').addEventListener('change', updateFlags);
$('default').addEventListener('change', updateFlags);
function clear() {
  selected = '';
  $('form').reset();
  // Set explicitly: a new connection must never inherit the previous one's Default tick,
  // or creating it would quietly take the default away from another system.
  $('enabled').checked = true;
  $('default').checked = false;
  updateFlags();
  $('id').disabled = false;
  $('advanced').open = false;
  setPolicy({ readOnly: true, allowFreeSql: false });
  $('password').type = 'password';
  $('password').placeholder = 'Enter your SAP password';
  $('password-help').textContent = 'Enter the password for your SAP account.';
  updateAuth();
  updateSecurity();
  render();
}
function select(id) {
  const item = state.connections.find(c => c.id === id);
  if (!item) return;
  selected = id;
  for (const key of ['id', 'url', 'client', 'user', 'ca', 'servername']) $(key).value = item[key] || '';
  for (const key of ['enabled', 'default', 'insecureTls']) $(key).checked = Boolean(item[key]);
  updateFlags();
  $('password').value = '';
  $('password').placeholder = item.hasPassword ? 'Enter a replacement password' : 'Enter your SAP password';
  $('password-help').textContent = item.hasPassword
    ? 'A password is already saved for this connection. You do not need to enter it again. Enter a new password only to replace the saved one.'
    : 'Enter the password for your SAP account.';
  $('id').disabled = false;
  $('authType').value = item.authType || 'basic';
  setPolicy(item.policy);
  $('oauth-token').value = item.oauth?.tokenUrl || '';
  $('oauth-id').value = item.oauth?.clientId || '';
  $('oauth-scope').value = item.oauth?.scope || '';
  $('oauth-secret').value = '';
  $('sso2-command').value = item.sso2?.command || '';
  $('sso2-args').value = JSON.stringify(item.sso2?.args || []);
  $('sso2-timeout').value = item.sso2?.timeoutMs || 30000;
  $('show-password').checked = false;
  $('password').type = 'password';
  updateAuth();
  $('advanced').open = Boolean(item.insecureTls);
  updateSecurity();
  render();
  markSaved();
}
// A connection's settings only take effect when saved, and a change that was never saved
// looks exactly like one that did not work (a Default ticked but not saved leaves the
// old default in place). So the form remembers what was last loaded or saved, and the
// Save button is highlighted whenever what is on screen differs from it.
let savedSnapshot = '';
function formSnapshot() {
  try {
    return JSON.stringify(values());
  } catch (_) {
    // values() cannot be read (malformed SSO2 arguments): that is an unsaved edit too.
    return 'unreadable:' + Date.now();
  }
}
function markSaved() {
  savedSnapshot = formSnapshot();
  updateDirty();
}
function updateDirty() {
  const dirty = Boolean(selected) && formSnapshot() !== savedSnapshot;
  $('save-connection').classList.toggle('unsaved', dirty);
  $('unsaved-note').hidden = !dirty;
}
// Every field, list, choice and checkbox reports through these two events, including the
// Enabled and Default boxes, which live outside the form element but belong to it.
document.addEventListener('input', updateDirty);
document.addEventListener('change', updateDirty);
function render() {
  $('connection-actions').hidden = !selected;
  $('new-connection-heading').hidden = Boolean(selected);
  $('selected-name').textContent = selected ? 'Selected: ' + selected : '';
  const box = $('connections');
  box.replaceChildren();
  if (!state.connections.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No SAP connections yet.';
    box.append(empty);
  }
  for (const item of state.connections) {
    const button = document.createElement('button');
    button.className = `connection${selected === item.id ? ' active' : ''}`;
    const name = document.createElement('strong');
    name.textContent = `${item.id}${item.default ? ' ★' : ''}`;
    const details = document.createElement('span');
    details.textContent = `${item.client} · ${item.enabled ? 'Enabled' : 'Disabled'}${item.authType && item.authType !== 'basic' ? ` · ${item.authType.toUpperCase()}` : ''}${item.insecureTls ? ' · Insecure TLS' : ''}`;
    button.append(name, details);
    button.onclick = () => select(item.id);
    box.append(button);
  }
}
let logQueue = Promise.resolve();
function renderLogs(entries) {
  const box = $('activity-list');
  box.replaceChildren();
  if (!entries.length) {
    const p = document.createElement('p');
    p.textContent = 'No activity logs.';
    box.append(p);
  }
  for (const entry of [...entries].reverse()) {
    const section = document.createElement('section');
    section.className = 'activity-entry ' + entry.level;
    const time = document.createElement('time');
    time.dateTime = entry.at;
    time.textContent = new Date(entry.at).toLocaleString();
    const p = document.createElement('p');
    p.textContent = entry.message;
    section.append(time, p);
    box.append(section);
  }
}
function addLog(message, error = false, key, at) {
  logQueue = logQueue
    .then(async () => {
      const r = await call('/api/activity', 'POST', { message, level: error ? 'error' : 'info', key, at });
      renderLogs(r.entries);
    })
    .catch(error => {
      const p = document.createElement('p');
      p.textContent = 'Could not save activity log: ' + error.message;
      $('activity-list').append(p);
    });
  return logQueue;
}
function showView(view) {
  for (const name of ['connections', 'logs', 'guide', 'about']) {
    $(name + '-view').hidden = name !== view;
    $(name + '-tab').setAttribute('aria-pressed', String(name === view));
  }
}
for (const view of ['connections', 'logs', 'guide', 'about']) $(view + '-tab').onclick = () => showView(view);
async function dismissWelcome() {
  try {
    await call('/api/preferences', 'POST', { setupSeen: true });
    $('welcome').hidden = true;
  } catch (error) {
    notify(error.message, true);
  }
}
$('welcome-guide').onclick = () => {
  showView('guide');
  dismissWelcome();
};
$('welcome-dismiss').onclick = dismissWelcome;
$('error-dismiss').onclick = () => {
  $('error-help').hidden = true;
};
$('clear-logs').onclick = async () => {
  try {
    await logQueue;
    renderLogs((await call('/api/activity', 'DELETE')).entries);
    $('client-summary').textContent = '';
    notify('Activity logs cleared.', false, false);
  } catch (error) {
    notify(error.message, true, false);
  }
};
function clientStatus(client) {
  return (
    {
      unchanged: 'Bridge already configured',
      configured: 'Bridge configured',
      skipped: 'not found',
      error: 'configuration failed',
      preserved: 'manual setup preserved; automatic setup skipped',
      'rolled-back': 'configuration rolled back',
    }[client.status] || client.status
  );
}
function showClients(report, announce = false) {
  if (!report) return;
  const summary = report.clients.map(c => c.client + ': ' + clientStatus(c)).join(' · ');
  const detail = report.clients
    .map(c =>
      [
        c.client + ': ' + clientStatus(c),
        c.message,
        ...(c.files || []).flatMap(f => [f.status + ': ' + f.message, f.file, f.backup ? 'Backup: ' + f.backup : '']),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  addLog(
    detail,
    report.clients.some(c => c.status === 'error'),
    'clients:' + JSON.stringify(report),
    report.ranAt,
  );
  if (announce) {
    $('client-summary').textContent = summary + ' — ' + new Date(report.ranAt).toLocaleString() + '. Details in Logs.';
    notify(
      summary,
      report.clients.some(c => c.status === 'error'),
      false,
    );
  }
}
async function refresh() {
  state = await call('/api/state');
  $('about-data-path').textContent = 'Data folder on this computer: ' + state.dataDir;
  // One source for the version: the manager reads it from package.json, which is also
  // what the installer and the desktop shell report, so none of them can disagree.
  $('app-version').textContent = state.version || '';
  $('about-version').textContent = state.version ? 'Version ' + state.version + '.' : '';
  render();
  showClients(state.clientSetup);
  for (const [label, messages] of [
    ['Existing registrations', state.registrationWarnings || []],
    ['Import', state.migration?.warnings || []],
  ])
    if (messages.length)
      addLog(
        label +
          '\n' +
          messages
            .map(m =>
              m.replace(
                'previously deleted in Bridge; not imported again. Use New or an encrypted backup to restore it deliberately.',
                'Skipped a previously removed connection. To add it again, choose New or restore an encrypted backup.',
              ),
            )
            .join('\n'),
        false,
        label + JSON.stringify(messages),
      );
  if (selected) select(selected);
}
$('new').onclick = clear;
// Tool names come from the MCP server that will enforce them, so a list cannot be
// built out of half-remembered names that quietly match nothing.
let toolCatalogue = { tools: [], toolsets: [] };
call('/api/tools')
  .then(result => {
    toolCatalogue = result;
  })
  .catch(() => {});
function currentLine(area) {
  const caret = area.selectionStart;
  const start = area.value.lastIndexOf('\n', caret - 1) + 1;
  const next = area.value.indexOf('\n', caret);
  const end = next < 0 ? area.value.length : next;
  return { start, end, text: area.value.slice(start, end).trim() };
}
function toolChoices(typed) {
  const needle = typed.toLowerCase();
  const entries = [
    ...toolCatalogue.toolsets.map(name => ({ label: 'toolset:' + name, hint: 'every tool in ' + name })),
    ...toolCatalogue.tools.map(tool => ({ label: tool.name, hint: tool.toolset + (tool.writes ? ' \u00b7 can change SAP' : ' \u00b7 read only') })),
  ];
  if (!needle) return entries.slice(0, 12);
  // Names that start with what was typed are the likelier intent, so they come first.
  const starts = entries.filter(entry => entry.label.toLowerCase().startsWith(needle));
  const contains = entries.filter(entry => !entry.label.toLowerCase().startsWith(needle) && entry.label.toLowerCase().includes(needle));
  return [...starts, ...contains].slice(0, 12);
}
function showToolSuggestions(field) {
  const area = $(field);
  const box = $(field + '-suggest');
  const choices = toolChoices(currentLine(area).text);
  box.replaceChildren();
  for (const choice of choices) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'tool-suggestion';
    option.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.textContent = choice.label;
    const hint = document.createElement('small');
    hint.textContent = choice.hint;
    option.append(name, hint);
    // mousedown, not click: the textarea must not lose focus before the insert.
    option.onmousedown = event => {
      event.preventDefault();
      const line = currentLine(area);
      area.value = area.value.slice(0, line.start) + choice.label + area.value.slice(line.end);
      area.selectionStart = area.selectionEnd = line.start + choice.label.length;
      area.focus();
      describePolicy();
      showToolSuggestions(field);
    };
    box.append(option);
  }
  box.hidden = !choices.length;
}
for (const field of ['allowedTools', 'deniedTools']) {
  $(field).addEventListener('focus', () => showToolSuggestions(field));
  $(field).addEventListener('input', () => showToolSuggestions(field));
  $(field).addEventListener('click', () => showToolSuggestions(field));
  $(field).addEventListener('blur', () => { $(field + '-suggest').hidden = true; });
  $(field).addEventListener('keydown', event => { if (event.key === 'Escape') $(field + '-suggest').hidden = true; });
}

// Describe the policy as it is typed, so a pattern that will be refused is seen at once.
for (const key of POLICY_LISTS) $(key).oninput = describePolicy;
$('insecureTls').onchange = updateSecurity;
$('ca').oninput = updateSecurity;
$('choose-certificate').onclick = () => $('certificate-file').click();
$('clear-certificate').onclick = () => {
  // Clearing the field is how you go back to the system's trusted certificates. The
  // managed copy stays in the data folder; nothing is deleted behind the user's back.
  $('ca').value = '';
  updateSecurity();
  updateDirty();
  notify('Certificate cleared. Save the connection to use the system’s trusted certificates.');
};
$('certificate-file').onchange = async () => {
  const file = $('certificate-file').files[0];
  if (!file) return;
  const button = $('choose-certificate');
  button.disabled = true;
  try {
    if (file.size > 512 * 1024) throw new Error('Choose a certificate smaller than 512 KB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const result = await call('/api/certificate', 'POST', { name: file.name, content: btoa(binary) });
    $('ca').value = result.path;
    updateSecurity();
    updateDirty();
    notify('Certificate copied. Save the connection to use it.');
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
    $('certificate-file').value = '';
  }
};
$('form').onsubmit = async event => {
  event.preventDefault();
  try {
    await call('/api/save', 'POST', values());
    selected = $('id').value.trim();
    await refresh();
    // Reload what was actually stored, so the form shows the saved truth (a default that
    // moved, a cleared password field) and the Save highlight clears.
    select(selected);
    notify('Connection saved. Fully quit and reopen your configured MCP clients.');
  } catch (error) {
    notify(error.message, true);
  }
};
$('test').onclick = async () => {
  $('test').disabled = true;
  try {
    notify('Testing the MCP connection…', false, false);
    const result = await call('/api/test', 'POST', values());
    notify(result.message, !result.ok);
  } catch (error) {
    notify(error.message, true);
  } finally {
    $('test').disabled = false;
  }
};
$('authType').onchange = updateAuth;
$('delete').onclick = async () => {
  if (
    !selected ||
    !confirm(
      `Delete ${selected} from Bridge and prevent legacy import from adding it again? Other MCP registrations are independent.`,
    )
  )
    return;
  try {
    await call('/api/delete', 'POST', { id: selected });
    clear();
    await refresh();
    notify('Deleted from Bridge. Legacy import will skip it. Restart your MCP clients.');
  } catch (error) {
    notify(error.message, true);
  }
};
$('apply').onclick = async () => {
  $('apply').disabled = true;
  try {
    const result = await call('/api/apply', 'POST');
    showClients(result.result, true);
  } catch (error) {
    notify(error.message, true);
  } finally {
    $('apply').disabled = false;
  }
};
$('import').onclick = async () => {
  try {
    const result = await call('/api/import', 'POST');
    await refresh();
    const m = result.migration;
    notify(
      m.imported.length
        ? `Imported: ${m.imported.join(', ')}`
        : m.status === 'not-found'
          ? 'No existing connections were found.'
          : 'Nothing new to import.',
    );
  } catch (error) {
    notify(error.message, true);
  }
};
$('folder').onclick = async () => {
  $('folder').disabled = true;
  try {
    const result = window.bridgeDesktop?.openDataFolder
      ? await window.bridgeDesktop.openDataFolder()
      : await call('/api/open-folder', 'POST');
    $('folder-result').textContent = 'Bridge data folder: ' + result.path;
  } catch (error) {
    $('folder-result').textContent = error.message;
    notify(error.message, true);
  } finally {
    $('folder').disabled = false;
  }
};
$('show-password').onchange = async () => {
  try {
    if ($('show-password').checked && !$('password').value && selected) {
      const result = await call('/api/reveal', 'POST', { id: selected });
      $('password').value = result.password;
    }
    $('password').type = $('show-password').checked ? 'text' : 'password';
  } catch (error) {
    $('show-password').checked = false;
    notify(error.message, true);
  }
};
$('duplicate').onclick = async () => {
  try {
    if (!selected) throw new Error('Save a connection before duplicating it.');
    const result = await call('/api/duplicate', 'POST', { id: selected });
    selected = result.connection.id;
    await refresh();
    notify(
      'Duplicated the saved connection, with its credentials and settings. Any unsaved edits in the form were not copied.',
    );
  } catch (error) {
    notify(error.message, true);
  }
};
$('diagnostics').onclick = async () => {
  try {
    if (!selected) throw new Error('Save a connection first.');
    $('diagnostics').disabled = true;
    notify('Running full diagnostics…', false, false);
    const result = await call('/api/diagnostics', 'POST', { id: selected });
    addLog(
      'Diagnostics: ' +
        selected +
        '\n' +
        [
          result.bridge.message,
          ...result.clients.map(x => `${x.client}: ${x.status} — ${x.message}`),
          result.message,
        ].join('\n'),
    );
    const failed = !result.bridge.ok ? result.bridge : result.clients.find(c => c.status === 'failed');
    notify(failed ? failed.message : 'Diagnostics complete. See Logs for results.', Boolean(failed), false);
  } catch (error) {
    notify(error.message, true);
  } finally {
    $('diagnostics').disabled = false;
  }
};
$('import-vault').onclick = () => $('vault-file').click();
$('vault-file').onchange = async () => {
  try {
    const file = $('vault-file').files[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) throw new Error('Vault file exceeds 16 MB.');
    const result = await call('/api/import-vault', 'POST', { name: file.name, content: await file.text() });
    await refresh();
    notify(`Imported: ${result.imported.length}. Preserved existing: ${result.skipped.length}. Details in Logs.`);
  } catch (error) {
    notify(error.message, true);
  } finally {
    $('vault-file').value = '';
  }
};
$('export-backup').onclick = async () => {
  try {
    const result = await call('/api/export', 'POST', { passphrase: $('backup-passphrase').value });
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'SAP-connections.sapmcp';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('backup-passphrase').value = '';
    notify('Encrypted backup ready. Keep its passphrase separately.');
  } catch (error) {
    notify(error.message, true);
  }
};
$('import-backup').onclick = () => {
  if (!$('backup-passphrase').value) {
    notify('Enter the passphrase used to create this backup before choosing its file.', true);
    $('backup-passphrase').focus();
    return;
  }
  $('backup-file').click();
};
$('backup-file').onchange = async () => {
  try {
    const file = $('backup-file').files[0];
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) throw new Error('Backup exceeds 32 MB.');
    const result = await call('/api/restore', 'POST', {
      backup: JSON.parse(await file.text()),
      passphrase: $('backup-passphrase').value,
    });
    $('backup-passphrase').value = '';
    await refresh();
    if (result.warnings?.length) await addLog('Imported backup warnings\n' + result.warnings.join('\n'), true);
    notify(
      `Imported ${result.imported.length}; preserved ${result.skipped.length} existing connections.${result.warnings?.length ? ' Review the warnings in Logs.' : ''}`,
      false,
      false,
    );
  } catch (error) {
    notify(error.message, true);
  } finally {
    $('backup-file').value = '';
  }
};
call('/api/activity')
  .then(r => renderLogs(r.entries))
  .catch(error => notify(error.message, true, false));
describePolicy();
updateAuth();
refresh().catch(error => notify(error.message, true));
