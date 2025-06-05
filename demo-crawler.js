#!/usr/bin/env node

/**
 * 🐕‍🦺 DeadLink Watchdog - Complete System Demo
 *
 * This script demonstrates the full DeadLink Watchdog system:
 * 1. Web crawling and link checking
 * 2. Nigerian website monitoring
 * 3. Broken link detection and categorization
 * 4. Health score calculation
 * 5. Real-world examples with Nigerian sites
 *
 * Run with: node demo-crawler.js
 */

const WebCrawler = require('./src/services/crawler');

async function demoCrawler() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                🐕‍🦺 DeadLink Watchdog Demo                      ║
║           Nigerian Website Link Monitor System              ║
╚══════════════════════════════════════════════════════════════╝
`);

  const crawler = new WebCrawler();

  try {
    // Demo 1: Show what happens with a real website
    console.log('💰 Demo 1: Crawling Wallet Wise App');
    console.log(
      'URL: http://wallet-wise-iota.vercel.app/ (Personal Finance App)'
    );
    console.log(
      'This is exactly what happens when you add your website to monitor...\n'
    );

    const walletWiseResult = await crawler.crawlWebsite(
      'http://wallet-wise-iota.vercel.app/',
      {
        depth: 1,
        onProgress: (progress) => {
          if (progress.phase === 'extraction') {
            console.log(`   📊 ${progress.message}`);
          } else if (progress.phase === 'checking') {
            if (
              progress.current % 10 === 0 ||
              progress.result.status === 'broken'
            ) {
              console.log(
                `   🔍 Progress: ${progress.current}/${progress.total} (${progress.percentage}%)`
              );
              if (progress.result.status === 'broken') {
                console.log(`      ❌ BROKEN LINK: ${progress.currentUrl}`);
                console.log(
                  `         Error: ${progress.result.errorType} (${
                    progress.result.statusCode || 'N/A'
                  })`
                );
              } else if (
                progress.result.status === 'success' &&
                progress.result.isExternalSocialMedia
              ) {
                console.log(
                  `      📱 SOCIAL MEDIA: ${progress.currentUrl} - Working!`
                );
              }
            }
          }
        },
      }
    );

    displayCrawlResults('Wallet Wise App', walletWiseResult);

    console.log('\n' + '='.repeat(70) + '\n');

    // Demo 2: Test different types of links
    console.log('🧪 Demo 2: Testing Different Link Scenarios');
    console.log(
      'This shows how the system categorizes different types of broken links...\n'
    );

    const testScenarios = [
      {
        url: 'https://samuel-oluwasegun.vercel.app/',
        description: 'My Portfolio',
      },
    ];

    for (const scenario of testScenarios) {
      console.log(`🔍 Testing: ${scenario.description}`);
      console.log(`   URL: ${scenario.url}`);

      try {
        const linkResult = await crawler.checkLink(scenario.url);

        if (linkResult.status === 'success') {
          console.log(
            `   ✅ Result: ${linkResult.status.toUpperCase()} (${
              linkResult.statusCode
            }) - ${linkResult.responseTime}ms`
          );
          if (linkResult.isExternalSocialMedia && linkResult.errorMessage) {
            console.log(`      📱 Note: ${linkResult.errorMessage}`);
          }
        } else {
          console.log(
            `   ❌ Result: ${linkResult.status.toUpperCase()} - ${
              linkResult.errorType
            }`
          );
          if (linkResult.statusCode) {
            console.log(`      HTTP Status: ${linkResult.statusCode}`);
          }
          if (linkResult.errorMessage) {
            console.log(`      Error Details: ${linkResult.errorMessage}`);
          }
          console.log(`      Response Time: ${linkResult.responseTime}ms`);
        }
      } catch (error) {
        console.log(`   💥 System Error: ${error.message}`);
      }
      console.log('');
    }

    console.log('\n' + '='.repeat(70) + '\n');

    // Demo 3: Show Nigerian website categories
    console.log('🏛️ Demo 3: Testing Different Nigerian Website Categories');
    console.log(
      'This demonstrates monitoring various types of Nigerian websites...\n'
    );

    const nigerianWebsites = [
      {
        url: 'https://www.cbn.gov.ng',
        category: 'Government',
        description: 'Central Bank of Nigeria',
      },
      {
        url: 'https://www.unn.edu.ng',
        category: 'Education',
        description: 'University of Nigeria, Nsukka',
      },
      {
        url: 'https://www.gtbank.com',
        category: 'Business',
        description: 'Guaranty Trust Bank',
      },
    ];

    for (const site of nigerianWebsites) {
      console.log(`🏢 Testing ${site.category} Website: ${site.description}`);
      console.log(`   URL: ${site.url}`);

      try {
        // Just test the homepage for speed
        const linkResult = await crawler.checkLink(site.url);

        if (linkResult.status === 'success') {
          console.log(
            `   ✅ Status: ONLINE (${linkResult.statusCode}) - ${linkResult.responseTime}ms`
          );
          console.log(
            `   📊 This website would be monitored for broken links automatically`
          );
        } else {
          console.log(
            `   ❌ Status: ${linkResult.status.toUpperCase()} - ${
              linkResult.errorType
            }`
          );
          console.log(
            `   🚨 This would trigger an alert in the monitoring system`
          );
        }
      } catch (error) {
        console.log(`   💥 Connection Error: ${error.message}`);
      }
      console.log('');
    }

    console.log('🎉 Demo completed successfully!');
    console.log('\n💡 This is exactly what happens when you:');
    console.log('   1. Add a website to monitor');
    console.log('   2. Trigger a manual crawl via API');
    console.log('   3. Or wait for automatic scheduled crawls');
    console.log('\n📚 Next steps:');
    console.log('   - Import the Postman collection');
    console.log('   - Start the API server: npm run dev');
    console.log('   - Add real Nigerian websites to monitor');
  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    console.log('\n💡 Make sure you have:');
    console.log('   - Internet connection');
    console.log('   - Chrome/Chromium installed (for Puppeteer)');
  } finally {
    await crawler.close();
  }
}

// Helper function to display crawl results nicely
function displayCrawlResults(siteName, result) {
  console.log(`\n📋 Crawl Results for ${siteName}:`);
  console.log(`   🔗 Total Links Found: ${result.totalLinksFound}`);
  console.log(`   ✅ Total Links Checked: ${result.totalLinksChecked}`);
  console.log(`   ❌ Broken Links: ${result.brokenLinksFound}`);
  console.log(`   🔄 Redirects: ${result.redirectsFound}`);
  console.log(`   ⏱️  Average Response Time: ${result.averageResponseTime}ms`);

  const healthScore =
    result.totalLinksChecked > 0
      ? Math.round(
          ((result.totalLinksChecked - result.brokenLinksFound) /
            result.totalLinksChecked) *
            100
        )
      : 100;

  const healthEmoji =
    healthScore >= 95 ? '🟢' : healthScore >= 80 ? '🟡' : '🔴';
  console.log(`   ${healthEmoji} Health Score: ${healthScore}%`);

  if (result.brokenLinks && result.brokenLinks.length > 0) {
    console.log('\n💔 Broken Links Found:');
    result.brokenLinks.slice(0, 5).forEach((link, index) => {
      console.log(`   ${index + 1}. ${link.url}`);
      console.log(
        `      ❌ Error: ${link.errorType} (${link.statusCode || 'N/A'})`
      );
      console.log(`      📍 Source: ${link.sourceUrl}`);
      if (link.linkText) {
        console.log(`      📝 Link Text: "${link.linkText}"`);
      }
      console.log('');
    });

    if (result.brokenLinks.length > 5) {
      console.log(
        `   ... and ${result.brokenLinks.length - 5} more broken links`
      );
    }
  } else {
    console.log('\n✨ No broken links found! Website is healthy.');
  }
}

// Helper function to show what a real crawl result looks like
function showExampleCrawlResult() {
  console.log(
    "\n📊 Example: What you'd see when crawling a Nigerian news site:\n"
  );

  const exampleResult = {
    website: 'https://punchng.com',
    totalLinksFound: 156,
    totalLinksChecked: 156,
    brokenLinksFound: 7,
    redirectsFound: 23,
    timeoutsFound: 2,
    averageResponseTime: 1340,
    healthScore: 95.5,
    brokenLinks: [
      {
        url: 'https://punchng.com/2019/old-article-removed',
        sourceUrl: 'https://punchng.com',
        linkText: 'Breaking News from 2019',
        statusCode: 404,
        errorType: '404_not_found',
      },
      {
        url: 'https://external-partner.com/dead-link',
        sourceUrl: 'https://punchng.com/sports',
        linkText: 'Sports Partner',
        errorType: 'connection_refused',
        errorMessage: 'ECONNREFUSED',
      },
    ],
  };

  console.log(JSON.stringify(exampleResult, null, 2));
}

// Run the demo
if (require.main === module) {
  console.log('🚀 Starting DeadLink Crawler Demo...\n');

  // Show example first
  showExampleCrawlResult();

  console.log('\n' + '='.repeat(60));
  console.log('🔴 LIVE DEMO - Real crawling starts now...');
  console.log('='.repeat(60) + '\n');

  demoCrawler().catch(console.error);
}

module.exports = { demoCrawler };
