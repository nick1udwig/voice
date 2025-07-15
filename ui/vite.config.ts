import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

/*
If you are developing a UI outside of a Hyperware project,
comment out the following 2 lines:
*/
import manifest from '../pkg/manifest.json'
import metadata from '../metadata.json'

/*
IMPORTANT:
This must match the process name from pkg/manifest.json + pkg/metadata.json
The format is "/" + "process_name:package_name:publisher_node"
*/
const BASE_URL = `/${manifest[0].process_name}:${metadata.properties.package_name}:${metadata.properties.publisher}`;

// This is the proxy URL, it must match the node you are developing against
const PROXY_URL = (process.env.VITE_NODE_URL || 'http://127.0.0.1:8080').replace('localhost', '127.0.0.1');

console.log('process.env.VITE_NODE_URL', process.env.VITE_NODE_URL, PROXY_URL);
console.log('BASE_URL:', BASE_URL);
console.log('WebSocket proxy path:', `${BASE_URL}/ws`);

// Custom plugin to copy worker files
const copyWorkersPlugin = () => {
  return {
    name: 'copy-workers',
    buildStart() {
      // During dev, copy to public
      try {
        mkdirSync(resolve('public'), { recursive: true });
        copyFileSync(resolve('shared/workers/audio-encoder.js'), resolve('public/audio-encoder.js'));
        copyFileSync(resolve('shared/workers/audio-decoder.js'), resolve('public/audio-decoder.js'));
        console.log('Copied worker files to public directory');
      } catch (err) {
        console.error('Error copying worker files:', err);
      }
    },
    writeBundle() {
      // After build, copy to dist
      try {
        copyFileSync(resolve('shared/workers/audio-encoder.js'), resolve('dist/audio-encoder.js'));
        copyFileSync(resolve('shared/workers/audio-decoder.js'), resolve('dist/audio-decoder.js'));
        copyFileSync(resolve('public/audio-processor.js'), resolve('dist/audio-processor.js'));
        copyFileSync(resolve('public/encoderWorker.min.js'), resolve('dist/encoderWorker.min.js'));
        copyFileSync(resolve('public/decoderWorker.min.js'), resolve('dist/decoderWorker.min.js'));
        copyFileSync(resolve('public/decoderWorker.min.wasm'), resolve('dist/decoderWorker.min.wasm'));
        copyFileSync(resolve('public/opus-worker-encoder.js'), resolve('dist/opus-worker-encoder.js'));
        copyFileSync(resolve('public/opus-worker-decoder.js'), resolve('dist/opus-worker-decoder.js'));
        console.log('Copied worker files to dist directory');
      } catch (err) {
        console.error('Error copying worker files:', err);
      }
    }
  };
};

export default defineConfig({
  plugins: [react(), copyWorkersPlugin()],
  base: BASE_URL,
  build: {
    rollupOptions: {
      external: ['/our.js']
    }
  },
  server: {
    open: true,
    proxy: {
      '/our': {
        target: PROXY_URL,
        changeOrigin: true,
      },
      [`${BASE_URL}/our.js`]: {
        target: PROXY_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(BASE_URL, ''),
      },
      // WebSocket proxy configuration
      [`${BASE_URL}/ws`]: {
        target: PROXY_URL,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => {
          const rewritten = path.replace(BASE_URL, '');
          console.log('WebSocket path rewrite:', path, '->', rewritten);
          return rewritten;
        },
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('WebSocket proxy error', err);
          });
          proxy.on('upgrade', (req) => {
            console.log('WebSocket upgrade request:', req.url);
          });
          proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
            console.log('WebSocket proxy request:', req.url);
          });
        },
      },
      // WebSocket proxy
      [`${BASE_URL}/ws`]: {
        target: PROXY_URL,
        changeOrigin: true,
        ws: true,
        configure: (proxy, _options) => {
          proxy.on('upgrade', (req) => {
            console.log('WebSocket upgrade request:', req.url);
          });
        },
      },
      // This route will match all other HTTP requests to the backend
      [`^${BASE_URL}/(?!(@vite/client|src/.*|node_modules/.*|@react-refresh|$))`]: {
        target: PROXY_URL,
        changeOrigin: true,
      },
      // '/example': {
      //   target: PROXY_URL,
      //   changeOrigin: true,
      //   rewrite: (path) => path.replace(BASE_URL, ''),
      // // This is only for debugging purposes
      //   configure: (proxy, _options) => {
      //     proxy.on('error', (err, _req, _res) => {
      //       console.log('proxy error', err);
      //     });
      //     proxy.on('proxyReq', (proxyReq, req, _res) => {
      //       console.log('Sending Request to the Target:', req.method, req.url);
      //     });
      //     proxy.on('proxyRes', (proxyRes, req, _res) => {
      //       console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
      //     });
      //   },
      // },
    }
  }
});
