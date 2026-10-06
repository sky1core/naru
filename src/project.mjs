import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivateJSON } from './profile.mjs';
import { isWebURL, RelayError } from './protocol.mjs';

export function projectRoute(value) {
  if (!isWebURL(value)) return null;
  const url = new URL(value);
  const match = url.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[^/]+)?\/(project|c\/[^/]+)\/?$/);
  return match ? { origin: url.origin, id: match[1], home: match[2] === 'project' } : null;
}

const bindingSchema = z.strictObject({ version: z.literal(1), id: z.string(), origin: z.string(), url: z.string() })
  .refine(binding => {
    const route = projectRoute(binding.url);
    return route?.home && route.id === binding.id && route.origin === binding.origin;
  });

export function readProject(profile) {
  try { return bindingSchema.parse(JSON.parse(readFileSync(join(profile, 'project.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export class Project {
  constructor(profile, browser) { this.profile = profile; this.browser = browser; }
  get() { return readProject(this.profile); }
  require() {
    const binding = this.get();
    if (!binding) throw new RelayError('project_required', 'Bind a project before submitting a review.');
    return binding;
  }
  assertURL(binding, value) {
    const route = projectRoute(value);
    if (route?.id !== binding.id || route.origin !== binding.origin) {
      throw new RelayError('project_changed', 'The browser is outside the bound project.');
    }
  }
  async bind(documentId, signal) {
    this.browser.assertDocument(documentId);
    const view = await this.browser.reviewView(signal);
    const route = projectRoute(view.url);
    if (!route?.home || view.problem || !view.composer || (view.composerPlacement !== null && view.composerPlacement !== 'home')) {
      throw new RelayError('project_page_required', 'Open the project home with its composer before binding.');
    }
    const snapshot = await this.browser.snapshot();
    const rows = snapshot.elements.filter(element => element.attributes['data-app-action-sidebar-project-id'] === route.id);
    if (rows.length !== 1) throw new RelayError('project_identity_missing', 'The project ID must be present uniquely in the sidebar.');
    this.browser.assertDocument(documentId);
    this.browser.assertActive(signal);
    const binding = { version: 1, id: route.id, origin: route.origin, url: view.url };
    writePrivateJSON(join(this.profile, 'project.json'), binding);
    return binding;
  }
  async open(signal, deadlineAt) {
    const binding = this.require();
    const current = await this.browser.reviewView(signal);
    if (current.problem) throw new RelayError(current.problem.code, current.problem.message);
    if (current.draft || current.busy || current.attachments) {
      throw new RelayError('draft_conflict', 'The current draft or generation must remain untouched.');
    }
    await this.browser.navigateReview(binding.url, current, signal, deadlineAt);
    while (true) {
      this.browser.assertActive(signal);
      const view = await this.browser.reviewView(signal);
      this.assertURL(binding, view.url);
      if (view.problem) throw new RelayError(view.problem.code, view.problem.message);
      if (!projectRoute(view.url)?.home || (view.composerPlacement !== null && view.composerPlacement !== 'home')) {
        throw new RelayError('project_page_required', 'The saved project home and its new-chat composer are required.');
      }
      if (view.composer) return { ...this.browser.status(), project: binding };
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new RelayError('project_not_ready', 'The project composer did not become ready.');
      await this.browser.waitReviewChange(view, remaining, signal);
    }
  }
}
