# 🐕‍🦺 DeadLink Watchdog

**A powerful API service that monitors broken links in Nigerian websites, ensuring optimal web health across Nigeria's digital landscape.**

## 🎯 What It Does

DeadLink Watchdog automatically monitors Nigerian websites for broken links:

1. **Users add websites** they want to monitor (news, government, business sites)
2. **System crawls websites** automatically (daily/weekly/monthly)
3. **Finds all links** on each page (typically 100+ links per site)
4. **Tests each link** for broken status (404, timeout, server errors)
5. **Calculates health scores** (e.g., 95% = 5 broken out of 100 links)
6. **Sends alerts** via email/webhook when issues are found
7. **Provides analytics** and trends over time

## ✨ Key Features

- 🔍 **Smart Web Crawling** - Puppeteer-powered link extraction and validation
- 📊 **Health Scoring** - Real-time website health metrics (0-100%)
- 🔔 **Instant Alerts** - Email and webhook notifications for broken links
- ⏰ **Auto Scheduling** - Daily, weekly, or monthly crawls
- 📈 **Analytics Dashboard** - Comprehensive statistics and trends
- 🇳🇬 **Nigerian Focus** - Optimized for local websites and infrastructure
- 🚀 **Production Ready** - Queue-based processing, authentication, error handling

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL with Sequelize ORM
- **Queue**: Redis with Bull for background jobs
- **Web Crawling**: Puppeteer for browser automation
- **Authentication**: JWT tokens
- **Notifications**: Nodemailer for email alerts

## Prerequisites

Before running this application, make sure you have:

- Node.js (v16 or higher)
- PostgreSQL (v12 or higher)
- Redis (v6 or higher)
- Git

## Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd deadlink-watchdog
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` file with your configuration:

   - Database credentials
   - Redis connection
   - JWT secret
   - Email settings (optional)

4. **Set up PostgreSQL database**

   ```bash
   # Create database
   createdb deadlink_watchdog_dev

   # Run migrations
   npm run db:migrate
   ```

5. **Start Redis server**
   ```bash
   redis-server
   ```

## Running the Application

### Development Mode

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

The API will be available at `http://localhost:3000`

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `POST /api/auth/refresh` - Refresh access token
- `GET /api/auth/me` - Get current user profile

### Websites

- `GET /api/websites` - List user's websites
- `POST /api/websites` - Add new website
- `GET /api/websites/:id` - Get website details
- `PUT /api/websites/:id` - Update website
- `DELETE /api/websites/:id` - Delete website
- `POST /api/websites/:id/crawl` - Trigger manual crawl

### Crawls

- `GET /api/crawls` - List crawl results
- `GET /api/crawls/:id` - Get crawl details
- `GET /api/crawls/:id/broken-links` - Get broken links for crawl
- `GET /api/crawls/stats/summary` - Get crawl statistics

### Dashboard

- `GET /api/dashboard/overview` - Dashboard overview
- `GET /api/dashboard/health-scores` - Website health scores
- `GET /api/dashboard/broken-links-summary` - Broken links summary
- `GET /api/dashboard/alerts` - System alerts

## Database Schema

### Users

- User authentication and profile information

### Websites

- Website details, crawl settings, and health metrics

### CrawlResults

- Results of each crawl operation

### BrokenLinks

- Detailed information about broken links found

## Configuration

### Environment Variables

| Variable                | Description                 | Default               |
| ----------------------- | --------------------------- | --------------------- |
| `PORT`                  | Server port                 | 3000                  |
| `NODE_ENV`              | Environment                 | development           |
| `DB_HOST`               | PostgreSQL host             | localhost             |
| `DB_PORT`               | PostgreSQL port             | 5432                  |
| `DB_NAME`               | Database name               | deadlink_watchdog_dev |
| `REDIS_HOST`            | Redis host                  | localhost             |
| `REDIS_PORT`            | Redis port                  | 6379                  |
| `JWT_SECRET`            | JWT signing secret          | (required)            |
| `CRAWLER_DELAY`         | Delay between requests (ms) | 1000                  |
| `MAX_CONCURRENT_CRAWLS` | Max concurrent crawl jobs   | 3                     |

### Crawl Frequencies

- **Daily**: Crawls every day at 2 AM
- **Weekly**: Crawls every Sunday at 2 AM
- **Monthly**: Crawls on the 1st of each month at 2 AM

## Usage Examples

### Register a User

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "firstName": "John",
    "lastName": "Doe"
  }'
```

### Add a Website

```bash
curl -X POST http://localhost:3000/api/websites \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "url": "https://example.com",
    "name": "Example Website",
    "category": "business",
    "crawlFrequency": "weekly",
    "notificationEmail": "alerts@example.com"
  }'
```

### Trigger Manual Crawl

```bash
curl -X POST http://localhost:3000/api/websites/WEBSITE_ID/crawl \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"crawlDepth": 2}'
```

## Monitoring

### Health Check

```bash
curl http://localhost:3000/health
```

### Queue Statistics

```bash
curl http://localhost:3000/api/admin/queue/stats \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

## Development

### Database Operations

```bash
# Create migration
npx sequelize-cli migration:generate --name migration-name

# Run migrations
npm run db:migrate

# Reset database
npm run db:reset
```

### Testing

```bash
npm test
```

## Deployment

### Using Docker (Coming Soon)

```bash
docker-compose up -d
```

### Manual Deployment

1. Set up production database and Redis
2. Configure environment variables
3. Run migrations
4. Start the application with PM2 or similar process manager

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For support and questions:

- Create an issue on GitHub
- Email: support@deadlinkwatchdog.com

---

**DeadLink Watchdog** - Keeping Nigerian websites healthy, one link at a time! 🇳🇬
