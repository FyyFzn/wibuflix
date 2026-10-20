/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are strictly forbidden across the codebase.',
      from: {},
      to: {
        circular: true
      }
    },
    {
      name: 'no-scrapers-to-stream',
      severity: 'error',
      comment: 'Scraper and extractor logic must never import from stream/transcoding/upload modules (SRP).',
      from: {
        path: '^src/services/(scrapers|extractors)/'
      },
      to: {
        path: '^src/services/stream/'
      }
    },
    {
      name: 'no-stream-to-scrapers',
      severity: 'error',
      comment: 'Stream/upload logic must never import from scraper or extractor modules (SRP).',
      from: {
        path: '^src/services/stream/'
      },
      to: {
        path: '^src/services/(scrapers|extractors)/'
      }
    },
    {
      name: 'no-controllers-to-scrapers',
      severity: 'error',
      comment: 'Controllers must delegate to services (ProviderRegistry, animeOrchestrator) instead of importing scrapers directly.',
      from: {
        path: '^src/controllers/'
      },
      to: {
        path: '^src/services/scrapers/'
      }
    },
    {
      name: 'no-puppeteer',
      severity: 'error',
      comment: 'Puppeteer was permanently removed; scraping must use curl_cffi Python service or native HTTP.',
      from: {},
      to: {
        path: '(puppeteer|puppeteer-extra|puppeteer-core|^src/puppeteer/)'
      }
    },
    {
      name: 'no-utils-to-controllers-or-routes',
      severity: 'error',
      comment: 'Utils are leaf modules and must never import from controllers or routes.',
      from: {
        path: '^src/utils/'
      },
      to: {
        path: '^src/(controllers|routes)/'
      }
    },
    {
      name: 'no-routes-to-scrapers',
      severity: 'error',
      comment: 'Routes must only bind controllers and middlewares; never import scrapers directly.',
      from: {
        path: '^src/routes/'
      },
      to: {
        path: '^src/services/scrapers/'
      }
    },
    {
      name: 'no-azure-blob-outside-stream',
      severity: 'error',
      comment: 'Azure BlobServiceClient must only be imported in src/services/stream/blobStorageService.js.',
      from: {
        pathNot: [
          '^src/services/stream/blobStorageService\.js$',
          '^src/tests/'
        ]
      },
      to: {
        path: '@azure/storage-blob'
      }
    },
    {
      name: 'no-express-in-services',
      severity: 'error',
      comment: 'Service modules must remain transport-agnostic and never import express.',
      from: {
        path: '^src/services/'
      },
      to: {
        path: 'express'
      }
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Modules should not be dangling without callers (excluding entrypoints, scripts, tests).',
      from: {
        orphan: true,
        pathNot: [
          '^src/server\.js$',
          '^src/scripts/',
          '^src/tests/'
        ]
      },
      to: {}
    }
  ],
  options: {
    doNotFollow: {
      path: 'node_modules'
    },
    exclude: {
      path: ['^node_modules', '^wibuflix-app', '^python', '^scratch', '\.git']
    },
    reporterOptions: {
      text: {
        highlightFocused: true
      }
    }
  }
};
