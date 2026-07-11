const WebCrawler = require('./src/services/crawler');

async function fastModeTest() {
  console.log('🚀 FAST MODE PERFORMANCE TEST');
  console.log('=' .repeat(50));
  
  // Test URLs - smaller set for quick comparison
  const testUrls = [
    'https://google.com',
    'https://github.com',
    'https://stackoverflow.com',
    'https://medium.com',
    'https://dev.to',
    'https://hashnode.com',
    'https://freecodecamp.org',
    'https://css-tricks.com',
    'https://smashingmagazine.com',
    'https://alistapart.com'
  ];
  
  console.log(`Testing with ${testUrls.length} URLs in both modes...`);
  console.log('');
  
  // Test 1: Normal Mode
  console.log('🐌 NORMAL MODE TEST');
  console.log('-' .repeat(30));
  
  const normalCrawler = new WebCrawler();
  normalCrawler.fastMode = false; // Ensure normal mode
  
  const normalStartTime = Date.now();
  const normalResults = [];
  
  try {
    for (let i = 0; i < testUrls.length; i++) {
      const url = testUrls[i];
      console.log(`  🚀 ${i + 1}/${testUrls.length}: ${url}`);
      
      const result = await normalCrawler.crawlWebsite(url, {
        depth: 1,
        onProgress: (progress) => {
          if (progress.phase === 'extraction') {
            console.log(`    📄 Found ${progress.message.split(' ')[1]} links`);
          }
        }
      });
      
      normalResults.push(result);
      console.log(`    ✅ Completed: ${result.totalLinksFound} links, ${result.brokenLinksFound} broken`);
    }
  } catch (error) {
    console.error('❌ Normal mode failed:', error.message);
  } finally {
    await normalCrawler.close();
  }
  
  const normalDuration = Date.now() - normalStartTime;
  
  // Test 2: Fast Mode
  console.log('\n🚀 FAST MODE TEST');
  console.log('-' .repeat(30));
  
  const fastCrawler = new WebCrawler();
  fastCrawler.fastMode = true; // Enable fast mode
  
  const fastStartTime = Date.now();
  const fastResults = [];
  
  try {
    for (let i = 0; i < testUrls.length; i++) {
      const url = testUrls[i];
      console.log(`  🚀 ${i + 1}/${testUrls.length}: ${url}`);
      
      const result = await fastCrawler.crawlWebsite(url, {
        depth: 1,
        onProgress: (progress) => {
          if (progress.phase === 'extraction') {
            console.log(`    📄 Found ${progress.message.split(' ')[1]} links`);
          }
        }
      });
      
      fastResults.push(result);
      console.log(`    ✅ Completed: ${result.totalLinksFound} links, ${result.brokenLinksFound} broken`);
    }
  } catch (error) {
    console.error('❌ Fast mode failed:', error.message);
  } finally {
    await fastCrawler.close();
  }
  
  const fastDuration = Date.now() - fastStartTime;
  
  // Results Comparison
  console.log('\n' + '=' .repeat(50));
  console.log('📊 PERFORMANCE COMPARISON');
  console.log('=' .repeat(50));
  
  const normalTotalLinks = normalResults.reduce((sum, r) => sum + r.totalLinksFound, 0);
  const normalBrokenLinks = normalResults.reduce((sum, r) => sum + r.brokenLinksFound, 0);
  const normalCacheHits = normalResults.reduce((sum, r) => sum + r.metrics.cacheHits, 0);
  
  const fastTotalLinks = fastResults.reduce((sum, r) => sum + r.totalLinksFound, 0);
  const fastBrokenLinks = fastResults.reduce((sum, r) => sum + r.brokenLinksFound, 0);
  const fastCacheHits = fastResults.reduce((sum, r) => sum + r.metrics.cacheHits, 0);
  
  console.log('🐌 NORMAL MODE:');
  console.log(`  ⏱️  Duration: ${(normalDuration / 1000).toFixed(2)}s`);
  console.log(`  🔗 Total Links: ${normalTotalLinks}`);
  console.log(`  ❌ Broken Links: ${normalBrokenLinks}`);
  console.log(`  💾 Cache Hits: ${normalCacheHits}`);
  console.log(`  📊 Links/sec: ${(normalTotalLinks / (normalDuration / 1000)).toFixed(1)}`);
  
  console.log('\n🚀 FAST MODE:');
  console.log(`  ⏱️  Duration: ${(fastDuration / 1000).toFixed(2)}s`);
  console.log(`  🔗 Total Links: ${fastTotalLinks}`);
  console.log(`  ❌ Broken Links: ${fastBrokenLinks}`);
  console.log(`  💾 Cache Hits: ${fastCacheHits}`);
  console.log(`  📊 Links/sec: ${(fastTotalLinks / (fastDuration / 1000)).toFixed(1)}`);
  
  console.log('\n🎯 IMPROVEMENTS:');
  const speedImprovement = ((normalDuration - fastDuration) / normalDuration * 100).toFixed(1);
  const linksPerSecondImprovement = ((fastTotalLinks / (fastDuration / 1000)) / (normalTotalLinks / (normalDuration / 1000))).toFixed(1);
  
  console.log(`  ⚡ Speed Improvement: ${speedImprovement}% faster`);
  console.log(`  🔗 Throughput: ${linksPerSecondImprovement}x more links/second`);
  console.log(`  📉 Link Reduction: ${((normalTotalLinks - fastTotalLinks) / normalTotalLinks * 100).toFixed(1)}% fewer links (smart filtering)`);
  
  console.log('\n🎉 CONCLUSION:');
  if (fastDuration < normalDuration * 0.5) {
    console.log('✅ EXCELLENT: Fast mode is 2x+ faster!');
  } else if (fastDuration < normalDuration * 0.7) {
    console.log('✅ GOOD: Fast mode is significantly faster!');
  } else {
    console.log('⚠️  FAIR: Some improvement, but could be better');
  }
  
  console.log('\n🚀 RECOMMENDATIONS:');
  console.log('1. Use FAST MODE for bulk crawling (20+ sites)');
  console.log('2. Use NORMAL MODE for detailed analysis (1-5 sites)');
  console.log('3. Fast mode skips scripts, CSS, and background images');
  console.log('4. Fast mode limits to 100 links per site');
  console.log('5. Fast mode disables rate limiting for speed');
  
  console.log('\n💡 USAGE:');
  console.log('Set CRAWLER_FAST_MODE=true in environment for bulk operations');
  console.log('Or set fastMode: true when creating WebCrawler instance');
}

fastModeTest().catch(console.error);

