import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'VERI-Real Trust Indicator',
  description:
    'Detect synthetic media and display trust badges backed by AI + blockchain evidence.',
  version: '0.1.0',
  action: {
    default_title: 'VERI-Real',
    default_popup: 'src/popup/index.html',
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png'
    }
  },
  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png'
  },
  permissions: ['storage', 'activeTab', 'scripting'],
  host_permissions: [
    'http://localhost:3000/*',
     'http://localhost:8000/*',
     'https://x.com/*',
     'https://twitter.com/*',
     'https://www.youtube.com/*',
     'https://youtube.com/*',
     'https://m.youtube.com/*'
  ],
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module'
  },
  content_scripts: [
    {
      matches: [
         'https://x.com/*',
         'https://twitter.com/*',
         'https://www.youtube.com/*',
         'https://youtube.com/*',
         'https://m.youtube.com/*'
      ],
      js: ['src/content/main.ts'],
      run_at: 'document_idle'
    }
  ],
  web_accessible_resources: [
    {
      resources: ['icons/icon6.png'],
      matches: [
        'https://x.com/*',
        'https://twitter.com/*',
        'https://www.youtube.com/*',
        'https://youtube.com/*',
        'https://m.youtube.com/*'
      ]
    }
  ]
});