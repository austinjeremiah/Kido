import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,

  /*
   * Pin the workspace root to this directory.
   *
   * Next infers the root by walking UP for a lockfile, and this app can sit
   * inside a checkout that has one of its own. Left to infer, it adopts that
   * outer repository as its root and traces the whole tree, every sibling app
   * and every node_modules with it. This app is self-contained, so its root is
   * its own directory wherever it happens to be checked out.
   */
  outputFileTracingRoot: here,

  /*
   * The Kido API (Backend/Kido, `npm run kido:api`). Every `/api/*` request the browser makes is
   * proxied to it on the server side, so the app is same-origin with its backend and needs no CORS.
   * Point KIDO_API_URL elsewhere to run against a remote API.
   */
  /*
   * Stylesheets in /public are served with max-age=0, which lets the browser
   * revalidate rather than refetch - and on a soft reload Chrome will often
   * serve the memory copy without revalidating at all. The result is edits that
   * are live on the server and invisible in the tab, which reads as a change
   * that did not apply. Development only; production wants the caching.
   */
  async headers() {
    if (process.env.NODE_ENV !== 'development') return [];
    return [{ source: '/styles/:path*', headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }] }];
  },

  async rewrites() {
    const api = (process.env.KIDO_API_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },

  experimental: {
    /*
     * The dev proxy behind `rewrites()` drops a request after 30 s by default. Design and
     * simulation calls run a model and hold the request open for longer than that; the backend
     * finishes fine, and the browser sees "socket hang up" instead. Ten minutes covers a build.
     */
    proxyTimeout: 600_000,

    // These are barrel files: a single `import { X } from 'lucide-react'` pulls
    // the whole index in dev unless Next rewrites it to a deep import. Matters a
    // lot for per-route dev compile time.
    optimizePackageImports: ['lucide-react', '@xyflow/react', '@tanstack/react-query'],

    /*
     * Turbopack options live under experimental.turbo on this version of Next;
     * the top-level `turbopack` key only exists from 15.3, where it would be
     * read and here would be silently ignored.
     *
     * resolveAlias matches EXACT specifiers - there is no prefix matching - so
     * every subpath has to be listed. These are optional micropayment SDKs
     * reached through
     *   RainbowKit -> wagmi connectors -> Coinbase baseAccount
     *   -> @base-org/account -> @coinbase/cdp-sdk -> @x402/*
     * No payment path is ever executed here, so they resolve to empty rather
     * than being installed.
     */
    turbo: {
      resolveAlias: {
        '@react-native-async-storage/async-storage': './lib/studio/empty-module.ts',
        'pino-pretty': './lib/studio/empty-module.ts',
        '@x402/core': './lib/studio/empty-module.ts',
        '@x402/core/client': './lib/studio/empty-module.ts',
        '@x402/core/server': './lib/studio/empty-module.ts',
        '@x402/core/types': './lib/studio/empty-module.ts',
        '@x402/evm': './lib/studio/empty-module.ts',
        '@x402/evm/batch-settlement/client': './lib/studio/empty-module.ts',
        '@x402/evm/exact/client': './lib/studio/empty-module.ts',
        '@x402/evm/exact/server': './lib/studio/empty-module.ts',
        '@x402/evm/exact/v1/client': './lib/studio/empty-module.ts',
        '@x402/evm/upto/client': './lib/studio/empty-module.ts',
        '@x402/evm/upto/server': './lib/studio/empty-module.ts',
        '@x402/express': './lib/studio/empty-module.ts',
        '@x402/extensions': './lib/studio/empty-module.ts',
        '@x402/extensions/bazaar': './lib/studio/empty-module.ts',
        '@x402/extensions/builder-code': './lib/studio/empty-module.ts',
        '@x402/fetch': './lib/studio/empty-module.ts',
        '@x402/svm': './lib/studio/empty-module.ts',
        '@x402/svm/exact/client': './lib/studio/empty-module.ts',
        '@x402/svm/exact/server': './lib/studio/empty-module.ts',
        '@x402/svm/exact/v1/client': './lib/studio/empty-module.ts',
      },
    },
  },

  webpack: (config, { isServer, webpack }) => {
    // RainbowKit's index imports wagmi's full connector set, which pulls in
    // @coinbase/cdp-sdk and its optional @x402/* payment modules. The wallet is
    // used only to connect and sign on a testnet — no payment path is ever
    // executed — so the whole namespace is ignored rather than adding payment
    // SDKs as dependencies.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^@x402\//,
      }),
    );

    // @metamask/sdk ships one bundle for web and React Native and imports the
    // RN async-storage package unconditionally. In a browser build that code
    // path is never taken, so point it at false rather than installing a React
    // Native dependency into a Next.js app.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@react-native-async-storage/async-storage': false,
    };

    config.externals = config.externals || [];
    if (Array.isArray(config.externals)) {
      config.externals.push('pino-pretty', 'lokijs', 'encoding');
    }

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }

    return config;
  },
};

export default nextConfig;
