#!/usr/bin/env node
import { minify } from 'terser';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src-client');
const publicDir = join(__dirname, 'public');

// Non-module files: terser + obfuscator only
const simpleTargets = ['themes.js', 'analytics.js', 'tutorial-tour.js', 'dev-panel.js'];

// Obfuscator config — focused on making code unreadable without bloating size
const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayEncoding: ['none'],
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false,
};

// app.js: esbuild (bundle imports) -> terser -> obfuscator
async function buildApp() {
  const entryPath = join(srcDir, 'app.js');

  // Step 0: esbuild bundles ES module imports into a single file
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    // xterm libraries stay as external (loaded from separate files)
    external: [
      './lib/xterm.mjs', './lib/addon-fit.mjs', './lib/addon-web-links.mjs',
    ],
    write: false,
    minify: false,
    target: 'es2020',
    sourcemap: false,
  });

  const bundled = result.outputFiles[0].text;
  const originalSize = Buffer.byteLength(bundled);

  // Step 1: Terser minification
  const minified = await minify(bundled, {
    compress: { dead_code: true, drop_console: false, passes: 2 },
    mangle: { toplevel: false },
    format: { comments: false },
    module: true,
  });

  if (minified.error) {
    console.error('  Terser error on app.js:', minified.error);
    process.exit(1);
  }

  // Step 2: javascript-obfuscator
  const obfuscated = JavaScriptObfuscator.obfuscate(minified.code, obfuscatorOptions);
  const finalCode = obfuscated.getObfuscatedCode();
  const finalSize = Buffer.byteLength(finalCode);

  writeFileSync(join(publicDir, 'app.min.js'), finalCode);

  const ratio = ((1 - finalSize / originalSize) * 100).toFixed(1);
  console.log(`  app.js -> app.min.js (via esbuild bundle)`);
  console.log(`    ${(originalSize / 1024).toFixed(1)}K -> ${(finalSize / 1024).toFixed(1)}K (${ratio}% reduction)\n`);
}

// Simple files: terser -> obfuscator (no bundling needed)
async function buildSimple(file) {
  const inputPath = join(srcDir, file);
  const outputPath = join(publicDir, file.replace('.js', '.min.js'));

  const source = readFileSync(inputPath, 'utf8');
  const originalSize = Buffer.byteLength(source);

  const minified = await minify(source, {
    compress: { dead_code: true, drop_console: false, passes: 2 },
    mangle: { toplevel: true },
    format: { comments: false },
    module: false,
  });

  if (minified.error) {
    console.error(`  Terser error on ${file}:`, minified.error);
    process.exit(1);
  }

  const obfuscated = JavaScriptObfuscator.obfuscate(minified.code, obfuscatorOptions);
  const finalCode = obfuscated.getObfuscatedCode();
  const finalSize = Buffer.byteLength(finalCode);

  writeFileSync(outputPath, finalCode);

  const ratio = ((1 - finalSize / originalSize) * 100).toFixed(1);
  console.log(`  ${file} -> ${file.replace('.js', '.min.js')}`);
  console.log(`    ${(originalSize / 1024).toFixed(1)}K -> ${(finalSize / 1024).toFixed(1)}K (${ratio}% reduction)\n`);
}

async function build() {
  console.log('Building minified + obfuscated JS...\n');
  await buildApp();
  for (const file of simpleTargets) {
    await buildSimple(file);
  }
  console.log('Done.');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
