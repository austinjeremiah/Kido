/**
 * Activity rail, explorer groups and per-page metadata.
 *
 * The rail switches which explorer groups are visible (IDE view containers).
 * Page metadata carries the title, the one-line purpose, the agent page-kind and
 * the page-specific Kido Assistant quick prompts defined in the product spec.
 */
import type { PageKind } from './types';

export type RailViewId =
  | 'project'
  | 'design'
  | 'test'
  | 'code'
  | 'deploy'
  | 'operate'
  | 'integrations'
  | 'reports'
  | 'settings';

export type IconName =
  | 'layout-grid'
  | 'pencil-ruler'
  | 'flask-conical'
  | 'file-code'
  | 'rocket'
  | 'activity'
  | 'plug'
  | 'file-text'
  | 'settings'
  | 'message-square'
  | 'users'
  | 'file-json'
  | 'workflow'
  | 'shield'
  | 'play'
  | 'globe'
  | 'swords'
  | 'database'
  | 'list-checks'
  | 'box'
  | 'gauge'
  | 'scroll'
  | 'server'
  | 'radio'
  | 'link'
  | 'fingerprint'
  | 'shield-check'
  | 'folder';

export interface NavItem {
  id: string;
  label: string;
  /** Route segment appended to /projects/:projectId */
  segment: string;
  icon: IconName;
  pageKind: PageKind;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export interface RailView {
  id: RailViewId;
  label: string;
  /** What the rail prints under the icon: one word, one line. */
  short: string;
  icon: IconName;
  /** Explorer groups shown when this rail entry is active. */
  groupIds: string[];
}

export const NAV_GROUPS: NavGroup[] = [
  { id: 'project', label: 'Project', items: [{ id: 'composer', label: 'Composer', segment: 'build', icon: 'message-square', pageKind: 'composer' }] },
  {
    id: 'design',
    label: 'Design',
    items: [
      { id: 'blueprint', label: 'Blueprint', segment: 'blueprint', icon: 'file-json', pageKind: 'blueprint' },
      { id: 'architecture', label: 'Architecture', segment: 'architecture', icon: 'workflow', pageKind: 'architecture' },
      { id: 'security', label: 'Permissions & Security', segment: 'security', icon: 'shield', pageKind: 'permissions' },
    ],
  },
  { id: 'test', label: 'Test', items: [{ id: 'simulation', label: 'Simulation', segment: 'simulation', icon: 'play', pageKind: 'simulation' }] },
  { id: 'implement', label: 'Integrate', items: [{ id: 'integrations', label: 'Providers', segment: 'integrations', icon: 'database', pageKind: 'integrations' }] },
  { id: 'deploy', label: 'Deploy', items: [{ id: 'preflight', label: 'Deploy', segment: 'deploy', icon: 'rocket', pageKind: 'deploy' }] },
  {
    id: 'operate',
    label: 'Operate',
    items: [
      { id: 'overview', label: 'Overview', segment: 'overview', icon: 'gauge', pageKind: 'overview' },
      { id: 'activity', label: 'Activity', segment: 'activity', icon: 'scroll', pageKind: 'activity' },
      { id: 'policies', label: 'Authority', segment: 'policies', icon: 'shield-check', pageKind: 'policies' },
      { id: 'runtime', label: 'Runtime', segment: 'runtime', icon: 'server', pageKind: 'runtime' },
      { id: 'identity', label: 'Identity', segment: 'identity', icon: 'fingerprint', pageKind: 'identity' },
    ],
  },
  { id: 'output', label: 'Output', items: [{ id: 'reports', label: 'Safety Report', segment: 'reports', icon: 'file-text', pageKind: 'reports' }] },
  { id: 'workspace', label: 'Workspace', items: [{ id: 'settings', label: 'Settings', segment: 'settings', icon: 'settings', pageKind: 'settings' }] },
];

export const RAIL_VIEWS: RailView[] = [
  { id: 'project', label: 'Project / Composer', short: 'Build', icon: 'layout-grid', groupIds: ['project'] },
  { id: 'design', label: 'Design', short: 'Design', icon: 'pencil-ruler', groupIds: ['design'] },
  { id: 'test', label: 'Test', short: 'Test', icon: 'flask-conical', groupIds: ['test'] },
  { id: 'deploy', label: 'Deploy', short: 'Deploy', icon: 'rocket', groupIds: ['deploy'] },
  { id: 'operate', label: 'Operate', short: 'Operate', icon: 'activity', groupIds: ['operate'] },
  { id: 'integrations', label: 'Providers', short: 'Providers', icon: 'plug', groupIds: ['implement'] },
  { id: 'reports', label: 'Reports', short: 'Reports', icon: 'file-text', groupIds: ['output'] },
];

/** Settings lives in the rail footer next to Help rather than among the build stages. */
export const SETTINGS_RAIL_VIEW: RailView = { id: 'settings', label: 'Settings', short: 'Settings', icon: 'settings', groupIds: ['workspace'] };

/** Every rail view, wherever it is rendered — use this for lookups by id. */
export const ALL_RAIL_VIEWS: RailView[] = [...RAIL_VIEWS, SETTINGS_RAIL_VIEW];

/** Which rail entry owns a given route segment, so navigation keeps the rail in sync. */
export const SEGMENT_TO_RAIL: Record<string, RailViewId> = {
  build: 'project',
  blueprint: 'design',
  architecture: 'design',
  security: 'design',
  simulation: 'test',
  integrations: 'integrations',
  deploy: 'deploy',
  overview: 'operate',
  activity: 'operate',
  policies: 'operate',
  runtime: 'operate',
  identity: 'operate',
  reports: 'reports',
  settings: 'settings',
};

export interface PageMeta {
  segment: string;
  title: string;
  /** Short tab label used by the editor tab bar. */
  tabTitle: string;
  purpose: string;
  pageKind: PageKind;
  /** Kido Assistant empty-state suggestions for this page (spec §6.5). */
  quickPrompts: string[];
}

export const PAGE_META: Record<string, PageMeta> = {
  "build": { segment: "build", title: "Composer", tabTitle: "Composer", purpose: "The design interview and the lifecycle gates: blueprint, security review, simulation and build.", pageKind: "composer", quickPrompts: ["What are you allowed to do?", "What can you never do?", "Why is the build blocked?"] },
  "blueprint": { segment: "blueprint", title: "Blueprint", tabTitle: "Blueprint", purpose: "The canonical blueprint revision every other page and the build compile from.", pageKind: "blueprint", quickPrompts: ["What are your limits?", "Which chains do you act on?", "What happens if your lease is revoked?"] },
  "architecture": { segment: "architecture", title: "Architecture", tabTitle: "Architecture", purpose: "How the agent observes, decides and acts, and where authority is enforced.", pageKind: "architecture", quickPrompts: ["Which protocols do you use?", "Who enforces your limits?", "How is your data sourced?"] },
  "security": { segment: "security", title: "Permissions & Security", tabTitle: "Permissions", purpose: "What this agent can do, what it can never do, and what the review found.", pageKind: "permissions", quickPrompts: ["What can you never do?", "Who can you pay?", "Can you withdraw funds?"] },
  "simulation": { segment: "simulation", title: "Simulation", tabTitle: "Simulation", purpose: "Every declared scenario, including attacks that must be refused, run against this revision.", pageKind: "simulation", quickPrompts: ["What happens if your lease is revoked?", "What happens if the oracle fails?", "Can you exceed your limits?"] },
  "integrations": { segment: "integrations", title: "Providers", tabTitle: "Providers", purpose: "Every provider Kido can select, with what each has actually proven.", pageKind: "integrations", quickPrompts: ["Is your privacy provider live or simulated?", "Which providers do you use?", "Is Wormhole live?"] },
  "deploy": { segment: "deploy", title: "Deploy", tabTitle: "Deploy", purpose: "Create the agent's Amane accounts and install the policy your wallet signs.", pageKind: "deploy", quickPrompts: ["What will deploying create?", "Who holds the root keys?", "What are your limits?"] },
  "overview": { segment: "overview", title: "Overview", tabTitle: "Overview", purpose: "Where this agent is in its lifecycle, and what it is allowed to do.", pageKind: "overview", quickPrompts: ["What are you allowed to do?", "What is your status?", "What happens if your lease is revoked?"] },
  "activity": { segment: "activity", title: "Activity", tabTitle: "Activity", purpose: "Every lifecycle and on-chain event for this agent.", pageKind: "activity", quickPrompts: ["What did you do last?", "Were any actions rejected?"] },
  "policies": { segment: "policies", title: "Authority", tabTitle: "Authority", purpose: "The owner policy and the agent lease: limits, payees and actions, per chain.", pageKind: "policies", quickPrompts: ["What are your limits?", "Who can you pay?", "How long is your lease?"] },
  "runtime": { segment: "runtime", title: "Runtime", tabTitle: "Runtime", purpose: "The agent's Amane accounts on each chain, their balances and lease state.", pageKind: "runtime", quickPrompts: ["Is your lease active?", "What happens if you are paused?"] },
  "identity": { segment: "identity", title: "Identity", tabTitle: "Identity", purpose: "The agent's public identity (ENS, SuiNS). Names are discovery, never authority.", pageKind: "identity", quickPrompts: ["What is your public name?", "Does your name grant you authority?"] },
  "reports": { segment: "reports", title: "Safety Report", tabTitle: "Safety Report", purpose: "The review, simulation, build and provider status for this revision, in one report.", pageKind: "reports", quickPrompts: ["Summarize your safety guarantees.", "What has not been proven?"] },
  "settings": { segment: "settings", title: "Settings", tabTitle: "Settings", purpose: "Project name and local preferences.", pageKind: "settings", quickPrompts: ["What is your agent id?"] },
};

export function metaForSegment(segment: string): PageMeta {
  return PAGE_META[segment] ?? PAGE_META.overview;
}

/**
 * Route segment that owns a page kind.
 *
 * Not an identity mapping: the Composer lives at `build`, and Permissions at
 * `security`. Anything routing by page kind — an agent patch going back to the
 * page that owns its artifact — has to go through here.
 */
export function segmentForPageKind(pageKind: PageKind): string {
  for (const group of NAV_GROUPS) {
    const hit = group.items.find((item) => item.pageKind === pageKind);
    if (hit) return hit.segment;
  }
  return 'overview';
}

export function findNavItem(segment: string): NavItem | undefined {
  for (const group of NAV_GROUPS) {
    const hit = group.items.find((item) => item.segment === segment);
    if (hit) return hit;
  }
  return undefined;
}
