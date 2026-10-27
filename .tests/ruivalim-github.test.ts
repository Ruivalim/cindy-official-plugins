import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type HostMessageHandler = (message: Record<string, unknown>) => Promise<void>;

interface CindyFetchRequest {
  url: string;
  method?: string;
  body?: string;
}

interface CindyFetchResponse {
  ok: boolean;
  status?: number;
  body?: string;
  message?: string;
  headers?: Record<string, string>;
}

interface CindyMessage {
  type: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  message?: string;
}

const githubSource = readFileSync(
  new URL('../ruivalim-github/main.js', import.meta.url),
  'utf8',
);

/** Minimal BroadcastChannel stub: the plugin registers the settings-page connection test channel on start. */
class FakeBroadcastChannel {
  onmessage?: (event: { data?: unknown }) => void;

  postMessage(): void {}
}

function jsonResponse(data: unknown, status = 200): CindyFetchResponse {
  return { ok: true, status, body: JSON.stringify(data), headers: {} };
}

function createGithubHarness(
  respond: (request: CindyFetchRequest) => CindyFetchResponse | Promise<CindyFetchResponse>,
) {
  let handler: HostMessageHandler | undefined;
  const requests: CindyFetchRequest[] = [];
  const messages: CindyMessage[] = [];
  const cindy = {
    onHostMessage: vi.fn((nextHandler: HostMessageHandler) => {
      handler = nextHandler;
    }),
    send: vi.fn((message: CindyMessage) => {
      messages.push(message);
    }),
    fetch: vi.fn(async (request: CindyFetchRequest) => {
      requests.push(request);
      return respond(request);
    }),
  };

  new Script(githubSource, { filename: 'ruivalim-github/main.js' }).runInContext(
    createContext({
      cindy,
      BroadcastChannel: FakeBroadcastChannel,
      fetch: vi.fn(),
      setTimeout,
      clearTimeout,
      URL,
      encodeURIComponent,
    }),
  );
  if (!handler) throw new Error('GitHub (Rui) did not register its host-message handler');

  return {
    requests,
    async callCreateBranch(args: Record<string, unknown>): Promise<CindyMessage> {
      messages.length = 0;
      await handler!({
        type: 'tool-call',
        tool: 'call_tool',
        callId: 'call-1',
        args: { name: 'create_branch', args },
      });
      const result = messages.findLast((message) => message.type === 'tool-result');
      if (!result) throw new Error('GitHub (Rui) did not return a tool-result');
      return JSON.parse(JSON.stringify(result)) as CindyMessage;
    },
    async listGitDataTools(): Promise<CindyMessage> {
      messages.length = 0;
      await handler!({
        type: 'tool-call',
        tool: 'list_tools',
        callId: 'call-list',
        args: { category: 'git_data' },
      });
      const result = messages.findLast((message) => message.type === 'tool-result');
      if (!result) throw new Error('GitHub (Rui) did not return a tool-result');
      return JSON.parse(JSON.stringify(result)) as CindyMessage;
    },
  };
}

describe('GitHub (Rui) create_branch', () => {
  it.each(['main', 'master', 'release/next'])(
    'without a starting point, reads the repo default_branch=%s and then creates the branch',
    async (defaultBranch) => {
      const harness = createGithubHarness((request) => {
        if (request.url === 'https://api.github.com/repos/acme/demo') {
          return jsonResponse({ default_branch: defaultBranch });
        }
        if (
          request.url === `https://api.github.com/repos/acme/demo/git/ref/heads/${defaultBranch}`
        ) {
          return jsonResponse({ object: { sha: 'default-sha' } });
        }
        if (request.url.endsWith('/git/refs') && request.method === 'POST') {
          return jsonResponse({ ref: 'refs/heads/feature' }, 201);
        }
        throw new Error(`unexpected cindy.fetch request: ${request.url}`);
      });

      const result = await harness.callCreateBranch({
        owner: 'acme',
        repo: 'demo',
        branch: 'feature',
      });

      expect(result.ok).toBe(true);
      expect(harness.requests.map((request) => request.url)).toEqual([
        'https://api.github.com/repos/acme/demo',
        `https://api.github.com/repos/acme/demo/git/ref/heads/${defaultBranch}`,
        'https://api.github.com/repos/acme/demo/git/refs',
      ]);
      expect(JSON.parse(harness.requests[2].body ?? '{}')).toEqual({
        ref: 'refs/heads/feature',
        sha: 'default-sha',
      });
    },
  );

  it('with explicit from_ref, does not request repo metadata', async () => {
    const harness = createGithubHarness((request) => {
      if (request.url.endsWith('/git/ref/heads/develop')) {
        return jsonResponse({ object: { sha: 'develop-sha' } });
      }
      if (request.url.endsWith('/git/refs') && request.method === 'POST') {
        return jsonResponse({}, 201);
      }
      throw new Error(`unexpected cindy.fetch request: ${request.url}`);
    });

    const result = await harness.callCreateBranch({
      owner: 'acme',
      repo: 'demo',
      branch: 'feature',
      from_ref: 'develop',
    });

    expect(result.ok).toBe(true);
    expect(harness.requests.map((request) => request.url)).toEqual([
      'https://api.github.com/repos/acme/demo/git/ref/heads/develop',
      'https://api.github.com/repos/acme/demo/git/refs',
    ]);
  });

  it('with explicit from_sha, creates the branch directly without requesting any starting point', async () => {
    const harness = createGithubHarness((request) => {
      if (request.url.endsWith('/git/refs') && request.method === 'POST') {
        return jsonResponse({}, 201);
      }
      throw new Error(`unexpected cindy.fetch request: ${request.url}`);
    });

    const result = await harness.callCreateBranch({
      owner: 'acme',
      repo: 'demo',
      branch: 'feature',
      from_sha: 'explicit-sha',
    });

    expect(result.ok).toBe(true);
    expect(harness.requests).toHaveLength(1);
    expect(JSON.parse(harness.requests[0].body ?? '{}')).toEqual({
      ref: 'refs/heads/feature',
      sha: 'explicit-sha',
    });
  });

  it('when the repo metadata request fails, passes the GitHub API error through and does not request the ref', async () => {
    const harness = createGithubHarness(() => ({
      ok: true,
      status: 503,
      body: JSON.stringify({ message: 'Service Unavailable' }),
    }));

    const result = await harness.callCreateBranch({
      owner: 'acme',
      repo: 'demo',
      branch: 'feature',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 503');
    expect(harness.requests.map((request) => request.url)).toEqual([
      'https://api.github.com/repos/acme/demo',
    ]);
  });

  it('when the default branch ref request fails, passes the GitHub API error through and does not create the branch', async () => {
    const harness = createGithubHarness((request) => {
      if (request.url === 'https://api.github.com/repos/acme/demo') {
        return jsonResponse({ default_branch: 'master' });
      }
      if (request.url.endsWith('/git/ref/heads/master')) {
        return { ok: true, status: 404, body: JSON.stringify({ message: 'Not Found' }) };
      }
      throw new Error(`unexpected cindy.fetch request: ${request.url}`);
    });

    const result = await harness.callCreateBranch({
      owner: 'acme',
      repo: 'demo',
      branch: 'feature',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 404');
    expect(harness.requests).toHaveLength(2);
  });

  it('the tool catalog no longer claims the default is main', async () => {
    const result = await createGithubHarness(() => jsonResponse({})).listGitDataTools();
    const tools = result.result?.tools as Array<{
      name: string;
      description: string;
      params: string;
    }>;
    const createBranch = tools.find((tool) => tool.name === 'create_branch');

    expect(createBranch).toMatchObject({
      description: expect.stringContaining('repo default branch'),
      params: expect.stringContaining('default_branch'),
    });
    expect(`${createBranch?.description} ${createBranch?.params}`).not.toMatch(/default:? main/i);
  });
});
