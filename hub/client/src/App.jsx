import { useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { useApi } from './api.js';
import { DigestPage, DigestsHome, HomeLatestDigest } from './pages/digests.jsx';
import { GuidePage } from './pages/guide.jsx';
import { CustomPage } from './pages/custom.jsx';
import { ConversationPage, ConversationsIndexPage } from './pages/conversations.jsx';
import { PlanPage, PlansPage, RecordsPage, TestsPage } from './pages/plans.jsx';
import { AgentPage, AgentsPage, KnowledgeIndexPage, KnowledgePage, SkillPage, SkillsPage } from './pages/agents-skills.jsx';
import { StationDetailPage, StationsRedirect } from './pages/stations.jsx';
import { FeaturesPage } from './pages/features.jsx';
import { DocKindContext, subtabForKind } from './components/doc-kind.js';

/**
 * Section for the active-nav state, derived from the path — a tab lights ONLY
 * on its own routes (hn-nav-restructure-2026-08-15). The Digests tab became
 * HOME (design hub-home-custom-pages-design Part 1, the CEO 2026-08-29): `/`
 * is the Home tab's own route now — Home is THE landing surface, the brand
 * click lands there and the tab lights (superseding the 2026-08-15 "no tab
 * active on /" call, which predates Home being a section). Home groups
 * Digests (`/`, plus the carried-over /digests index + detail) and Guide
 * (`/guide`, the user manual) as subtabs.
 * Documents groups Plans/Tests/Records/Conversations as subtabs
 * (hn-documents-subtabs-2026-08-15 — the CEO, 2026-08-15); Core (knowledge) /
 * Agents / Skills / Features group under Claude — the Stations page merged into
 * the Features matrix (features-ui-restructure-design C-1, the CEO 2026-08-27):
 * `/stations` redirects there and `/stations/:env` is the per-station detail,
 * both living under the Features subtab. Custom pages (design Part 2, test
 * plan hub-pages-framework-core-2026-08-29) mount at `/pages/:slug`: each one
 * is its OWN top-level tab after the built-ins (section key `page:<slug>`,
 * no subtab strip), fed by the fail-soft /api/pages roster — feature off or a
 * roster error means built-in tabs only, never a broken header.
 */
function sectionOf(path) {
  if (path === '/' || path.startsWith('/digests') || path.startsWith('/guide')) return 'home';
  if (path.startsWith('/pages/')) return `page:${path.split('/')[2] || ''}`;
  if (
    path.startsWith('/plans') ||
    path.startsWith('/tests') ||
    path.startsWith('/records') ||
    path.startsWith('/conversations')
  ) {
    return 'documents';
  }
  if (
    path.startsWith('/knowledge') ||
    path.startsWith('/agents') ||
    path.startsWith('/skills') ||
    path.startsWith('/stations') ||
    path.startsWith('/features')
  ) {
    return 'claude';
  }
  return null;
}

/**
 * Active subtab inside a grouping section, derived the same way. `/plans/:slug`
 * hosts every plan kind, so there the loaded document's reported kind decides
 * (doc-kind.js); until it loads, no subtab is lit — never a wrong one.
 */
function subtabOf(path, docKind) {
  if (path === '/' || path.startsWith('/digests')) return 'digests';
  if (path.startsWith('/guide')) return 'guide';
  if (path.startsWith('/knowledge')) return 'core';
  if (path.startsWith('/agents')) return 'agents';
  if (path.startsWith('/skills')) return 'skills';
  if (path.startsWith('/stations')) return 'features'; // station detail lives under the merged surface
  if (path.startsWith('/features')) return 'features';
  if (path.startsWith('/tests')) return 'tests';
  if (path.startsWith('/records')) return 'records';
  if (path.startsWith('/conversations')) return 'conversations';
  if (/^\/plans\/./.test(path)) return subtabForKind(docKind);
  if (path.startsWith('/plans')) return 'plans';
  return null;
}

const SECTIONS = [
  ['Home', '/', 'home'],
  ['Documents', '/plans', 'documents'],
  ['Claude', '/knowledge', 'claude'],
];

/**
 * The grouping sections' subtabs — one pattern, one styling (nav.subtabs).
 * Home lands on Digests (the latest digest, the morning read — the CEO,
 * 2026-08-29); Claude lands on Core (the governing docs); Documents lands on
 * Plans (the CEO, 2026-08-15).
 */
const SUBTABS = {
  home: [
    ['Digests', '/', 'digests'],
    ['Guide', '/guide', 'guide'],
  ],
  claude: [
    ['Core', '/knowledge', 'core'],
    ['Agents', '/agents', 'agents'],
    ['Skills', '/skills', 'skills'],
    ['Features', '/features', 'features'],
  ],
  documents: [
    ['Plans', '/plans', 'plans'],
    ['Tests', '/tests', 'tests'],
    ['Records', '/records', 'records'],
    ['Conversations', '/conversations', 'conversations'],
  ],
};

function NotFound() {
  return (
    <div className="card">
      <h1>Not found</h1>
      <p>Page not found.</p>
      <p>
        <a href="/">Back to Home</a>
      </p>
    </div>
  );
}

export function App() {
  const [path] = useLocation();
  const [docKind, setDocKind] = useState(null);
  const section = sectionOf(path);
  const subtabs = SUBTABS[section];
  const subtab = subtabOf(path, docKind);
  // The nav brand is the instance's configured hub title (naming-is-config,
  // TP-ceoconf-012) — /api/identity is fail-soft server-side, so a load error
  // still yields the generic 'Hub', never a broken header.
  const identity = useApi('/api/identity');
  // Custom-page tabs after the built-ins, in the server's order (manifest
  // order then alphabetical — the scan decides, the nav renders). Fail-soft:
  // feature off or a roster error = built-in tabs only, never a broken header.
  const pagesRoster = useApi('/api/pages');
  const customPages = pagesRoster.data?.pages || [];
  const hubTitle = identity.data?.identity?.hubTitle || (identity.loading ? ' ' : 'Hub');

  return (
    <DocKindContext.Provider value={setDocKind}>
      <header className="site">
        <div className="brand">
          <Link href="/">{hubTitle}</Link>
        </div>
        <nav className="sections">
          {SECTIONS.map(([label, href, key]) => (
            <Link key={key} href={href} className={section === key ? 'active' : ''}>
              {label}
            </Link>
          ))}
          {customPages.map((p) => (
            <Link
              key={`page:${p.slug}`}
              href={`/pages/${p.slug}`}
              className={section === `page:${p.slug}` ? 'active' : ''}
            >
              {p.icon ? `${p.icon} ${p.title}` : p.title}
            </Link>
          ))}
        </nav>
      </header>
      {subtabs ? (
        <nav className="subtabs">
          {subtabs.map(([label, href, key]) => (
            <Link key={key} href={href} className={subtab === key ? 'active' : ''}>
              {label}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="shell">
        <main className="content">
          <Switch>
            <Route path="/" component={HomeLatestDigest} />
            <Route path="/digests" component={DigestsHome} />
            <Route path="/digests/:date" component={DigestPage} />
            <Route path="/guide" component={GuidePage} />
            <Route path="/pages/:slug" component={CustomPage} />
            <Route path="/conversations" component={ConversationsIndexPage} />
            <Route path="/conversations/:id" component={ConversationPage} />
            <Route path="/plans" component={PlansPage} />
            <Route path="/plans/:slug" component={PlanPage} />
            <Route path="/tests" component={TestsPage} />
            <Route path="/records" component={RecordsPage} />
            <Route path="/agents" component={AgentsPage} />
            <Route path="/agents/:name" component={AgentPage} />
            <Route path="/knowledge" component={KnowledgeIndexPage} />
            <Route path="/knowledge/:slug" component={KnowledgePage} />
            <Route path="/skills" component={SkillsPage} />
            <Route path="/skills/:name" component={SkillPage} />
            <Route path="/stations" component={StationsRedirect} />
            <Route path="/stations/:env" component={StationDetailPage} />
            <Route path="/features" component={FeaturesPage} />
            <Route component={NotFound} />
          </Switch>
        </main>
      </div>
      <footer className="site">
        hub · operations hub · <a href="/auth/logout">sign out</a>
      </footer>
    </DocKindContext.Provider>
  );
}
