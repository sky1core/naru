#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { connect } from './client.mjs';
import { defaultProfile } from './profile.mjs';
import { requestSchema, requestIdSchema, RelayError, publicError } from './protocol.mjs';
import { reviewCLI } from './review-cli.mjs';
import { readUTF8File } from './cli-files.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string', default: defaultProfile },
    help: { type: 'boolean', default: false },
    id: { type: 'string' }, document: { type: 'string' },
    attr: { type: 'string' }, value: { type: 'string' },
    file: { type: 'string', multiple: true }, out: { type: 'string' },
    part: { type: 'string' }, 'continue-from': { type: 'string' }, effort: { type: 'string' }, question: { type: 'string' }, request: { type: 'string' }, 'base-dir': { type: 'string' },
    state: { type: 'string', default: 'present' }, timeout: { type: 'string' },
    deadline: { type: 'string' },
  } });
  const [action, arg, ...extra] = positionals;
  if (values.help || !action) {
    console.log(`naru [--profile <directory>] <command>
  status | snapshot | diagnostics
  navigate <http(s) URL>
  fill --document <UUID> --attr <attribute> --value <value> --file <UTF-8 file>
  click | read --document <UUID> --attr <attribute> --value <value>
  press <Enter|Tab|Escape|ArrowLeft|ArrowRight> --document <UUID> --attr <attribute> --value <value>
  wait --document <UUID> --attr <attribute> --value <value> --state present|absent --timeout <ms>
  screenshot --out <new PNG file>
  request <UUID>
  run --file <JSON request: {id, command}>
  quit
  doctor
  project | project-bind | project-open
  prepare --question <question> [--file <source> ...] [--effort <none|medium|high|max|pro>] --out <new input JSON>
  ask --question <question> [--file <source> ...] [--effort <none|medium|high|max|pro>] --out <new answer file>
  ask --request <prepared input JSON> --out <new answer file>
  collect --out <same answer file>
  submit --out <same answer file>
  review-status <review UUID>
Without --continue-from, each new review opens a fresh document at the bound project home. Existing drafts and generations are preserved. Sends are never retried.
--part <N/TOTAL> sends ordered parts (TOTAL >= 2); parts after 1 require --continue-from <previous answer file>.
--part with the same N/TOTAL and --continue-from an incomplete part repairs its receipt without --file.
--continue-from <previous answer file> also sends an ordinary follow-up in the same conversation.
--effort selects and verifies the requested reasoning effort before sending; omitted effort preserves the current composer selection.
--base-dir <directory> sets the source path root. --timeout <ms> bounds collection (default 1800000).
Commands accept --id <UUID>; generated IDs are printed to stderr before dispatch.
--deadline <ms> bounds command execution in the main process (default 120000 for ask/submit/collect, 30000 for other commands; maximum 120000).
Targets: id, data-testid, name, type, data-message-id, data-message-author-role, data-composer-markdown, data-chatgpt-composer, data-composer-placement, data-app-action-sidebar-project-id, data-codex-intelligence-trigger, data-model-picker-view-toggle, data-map-composer-conversation, data-reasoning-slider, data-model-picker-view, href.
JSON targets accept an explicit scope with one attribute and value; both scope and target must be unique.
No visible-text selectors, arbitrary scripts, or automatic command retries.`);
  } else {
    if (extra.length) throw new RelayError('invalid_arguments', 'Too many positional arguments.', 400);
    let result;
    if (['prepare', 'ask', 'collect', 'submit', 'review-status', 'doctor'].includes(action)) {
      result = await reviewCLI(action, arg, values);
      if (action === 'doctor' && (result.problem || !result.composer || (result.draftPresent && !result.send))) process.exitCode = 1;
    } else {
    if (values.effort !== undefined || values.part !== undefined || values['continue-from'] !== undefined) throw new RelayError('invalid_arguments', '--effort, --part and --continue-from are only accepted by ask and prepare.', 400);
    const call = await connect(resolve(values.profile));
    const oneFile = () => {
      if (values.file?.length !== 1) throw new RelayError('invalid_arguments', 'Exactly one --file is required.', 400);
      return values.file[0];
    };
    if (['status', 'snapshot', 'diagnostics', 'project'].includes(action)) {
      if (arg) throw new RelayError('invalid_arguments', 'Unexpected positional argument.', 400);
      result = await call(`/v1/${action}`);
    } else if (action === 'request') {
      if (!requestIdSchema.safeParse(arg).success) throw new RelayError('invalid_request_id', 'Expected UUID.', 400);
      result = await call(`/v1/requests/${arg}`);
    } else {
      let request;
      if (action === 'run') {
        if (!values.file || arg) throw new RelayError('invalid_arguments', 'run requires --file and no positional argument.', 400);
        request = JSON.parse(await readUTF8File(oneFile()));
      } else {
        if (!['navigate', 'press'].includes(action) && arg) throw new RelayError('invalid_arguments', 'Unexpected positional argument.', 400);
        let command = { action };
        if (action === 'project-bind') command = { action: 'project.bind', documentId: (await call('/v1/status')).documentId };
        if (action === 'project-open') command = { action: 'project.open' };
        if (action === 'navigate') command.url = arg;
        if (['fill', 'click', 'press', 'read', 'wait'].includes(action)) {
          command = { ...command, documentId: values.document, target: { attribute: values.attr, value: values.value } };
        }
        if (action === 'fill') {
          if (!values.file) throw new RelayError('invalid_arguments', 'fill requires --file; text is never implicitly read from another source.', 400);
          command.text = await readUTF8File(oneFile());
        }
        if (action === 'press') command.key = arg;
        if (action === 'wait') Object.assign(command, { state: values.state, timeoutMs: Number(values.timeout === undefined ? '30000' : values.timeout) });
        if (action === 'screenshot' && !values.out) throw new RelayError('invalid_arguments', 'screenshot requires --out.', 400);
        request = { id: values.id === undefined ? randomUUID() : values.id, deadlineMs: values.deadline === undefined ? undefined : Number(values.deadline), command };
      }
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) throw new RelayError('invalid_command', JSON.stringify(parsed.error.issues), 400);
      console.error(JSON.stringify({ requestId: parsed.data.id }));
      result = await call('/v1/commands', parsed.data);
      if (action === 'screenshot') {
        await writeFile(values.out, Buffer.from(result.result.base64, 'base64'), { flag: 'wx', mode: 0o600 });
        result = { id: result.id, state: result.state, file: resolve(values.out) };
      }
    }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof RelayError ? publicError(error) : { code: 'cli_error', message: error.message } }));
  process.exitCode = 1;
}
