# lyrxl

A JavaScript-based application for managing and syncing song lyrics and metadata.

## Overview

**lyrxl** is a lyric management and translation system built with Node.js. It provides API endpoints for retrieving, caching, and translating song lyrics from various sources. The project uses LibSQL for database management and integrates with the Google AI API for intelligent content processing.

## Features

- 🎵 **Lyric Management** - Store and retrieve song lyrics with rich metadata
- 🌐 **Translation API** - Translate lyrics using AI-powered endpoints
- 💾 **Intelligent Caching** - Normalized database schema for efficient storage and retrieval
- 🔄 **Sync Support** - Handle both plain and synced lyric results
- 🚀 **ESM Architecture** - Modern JavaScript module system

## Tech Stack

- **Runtime**: Node.js
- **Language**: JavaScript (100%)
- **Database**: LibSQL
- **API**: Google Generative AI
- **Architecture**: REST API with middleware support

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- A LibSQL database
- Google AI API credentials

### Installation

1. Clone the repository:
```bash
git clone https://github.com/jayxdcode/lyrxl.git
cd lyrxl
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:
- LibSQL database credentials
- Google AI API key

### Running the Server

```bash
npm start
```

The server will start on the configured port.

## API Endpoints

### Translate Endpoint
- **POST** `/api/translate`
  - Request body: `{ lrclib_id: number, plain: boolean }`
  - Returns translated lyric content using AI processing

### Cache Endpoints
- **GET** `/api/cached/:lrclib_id` - Retrieve cached translations for a specific lyric ID
- **GET** `/cached/:lrclib_id` - Get cached content

## Database Schema

The application uses a normalized database schema with the following main tables:
- `translations` - Translated lyric content
- `song_metadata` - Song information and details
- `plain_results` - Unprocessed lyric results
- `synced_results` - Synchronized lyric data

## Recent Updates (v2.0.5)

- Removed ad-block layer and related dependencies
- Overhauled database schema with normalization
- Enhanced translation API with improved context
- Added JSON response format support
- Improved content extraction with multi-candidate support
- In-flight deduplication improvements
- Dependency updates for security and performance

## Project Status

Active development with regular updates and improvements.

## License

See LICENSE file for details.

## Author

[jayxdcode](https://github.com/jayxdcode)

---

For more information, visit the [repository](https://github.com/jayxdcode/lyrxl).
