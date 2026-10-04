// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightImageZoom from 'starlight-image-zoom';
import starlightLlmsTxt from 'starlight-llms-txt';

// https://astro.build/config
export default defineConfig({
	// Overridable so the same build works on the downdraft.dev custom domain
	// (base '/') or the default <owner>.github.io/downdraft-engine Pages URL.
	site: process.env.DOCS_SITE || 'https://downdraft.dev',
	base: process.env.DOCS_BASE || '/',
	integrations: [
		starlight({
			title: 'DownDraft',
			logo: {
				src: './src/assets/logo.svg',
				replacesTitle: true,
			},
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/knackstedt/downdraft-engine' },
			],
			customCss: [
				'./src/styles/custom.css',
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Development', slug: 'getting-started/development' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'ECS', slug: 'guides/ecs' },
						{ label: 'Rendering', slug: 'guides/rendering' },
						{ label: 'Physics', slug: 'guides/physics' },
						{ label: 'Animation', slug: 'guides/animation' },
						{ label: 'Audio', slug: 'guides/audio' },
						{ label: 'Particles', slug: 'guides/particles' },
						{ label: 'Plugins', slug: 'guides/plugins' },
						{ label: 'Native Modules (Rust)', slug: 'guides/native-modules' },
						{ label: 'Packaging & Distribution', slug: 'guides/packaging' },
						{ label: 'MCP & AI Agents', slug: 'guides/mcp' },
						],
				},
				{
					label: 'Architecture',
					items: [
						{ label: 'Process Model', slug: 'architecture/process-model' },
						{ label: 'SAB Communication', slug: 'architecture/sab-communication' },
						{ label: 'Render Pipeline', slug: 'architecture/render-pipeline' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'CLI Commands', slug: 'reference/cli' },
						{ label: 'Packages', slug: 'reference/packages' },
						{ label: 'Troubleshooting', slug: 'reference/troubleshooting' },
					],
				},
			],
			editLink: {
				baseUrl: 'https://github.com/knackstedt/downdraft-engine/edit/main/docs/site/',
			},
			lastUpdated: true,
			plugins: [
				starlightImageZoom({ showCaptions: true }),
				starlightLlmsTxt({
					projectName: 'DownDraft Engine',
					description: 'An AI-Driven Game Engine built on a native runtime (winit + wgpu under Bun, Node, or Deno) with TypeScript-first design and a built-in MCP server for AI agent interaction',
					promote: ['index*']
				}),
			]
		}),
	],
});
