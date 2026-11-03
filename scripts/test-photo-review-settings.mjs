// Browser regression for a mounted PhotoReview + SettingsPage using the synthetic
// reviewFixture from test-photo-review-modes.mjs. No real photo files are changed.
import assert from "node:assert/strict";

export async function testPhotoReviewSettings(page) {
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.reviewFixture.positions = [];
    window.reviewFixture.started = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "review_save_position") window.reviewFixture.positions.push(args);
      if (command === "review_mark") {
        window.reviewFixture.started.push(args);
        if (window.reviewFixture.hold)
          await new Promise(resolve => { window.reviewFixture.release = resolve; });
      }
      return invoke(command, args);
    };
  });
  await page.click('button:text-is("星级筛选")');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
  const before = await page.evaluate(() => window.reviewFixture.positions.length);
  await page.evaluate(() => { window.reviewFixture.hold = true; });
  await page.click('button[aria-label="2 星"]');
  await page.waitForFunction(() => !!window.reviewFixture.release);
  await page.evaluate(async () => {
    for (const rating of [3, 4, 5]) {
      document.querySelector(`button[aria-label="${rating} 星"]`).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    document.querySelector('[aria-label="审图设置"]').click();
  });
  await page.waitForSelector('.settings-review-back');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
  await page.click('.settings-review-back');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
  assert.equal(await page.evaluate(() => window.reviewFixture.positions.length), before,
    "settings round trips must not enqueue unchanged position writes");
  assert.equal(await page.locator('.photo-counter').textContent(), "1 / 2");
  await page.waitForFunction(() => document.querySelector('.photo-save-status').textContent.includes('等待存储响应'));
  assert.equal(await page.locator('.photo-save-status').textContent(), "等待存储响应 · 2 项待保存");
  assert.equal(await page.locator('button[aria-label="5 星"]').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => { window.reviewFixture.hold = false; window.reviewFixture.release(); });
  await page.waitForFunction(() => document.querySelector('.photo-save-status').textContent === '本机已保存');
  assert.deepEqual(await page.evaluate(() => window.reviewFixture.started.map(mark => mark.rating)), [2, 5]);
  assert.equal(await page.locator('.photo-counter').textContent(), "1 / 2");
  // A write that finishes while the review is hidden must be reflected on return.
  await page.evaluate(() => { window.reviewFixture.hold = true; });
  await page.click('button[aria-label="4 星"]');
  await page.click('[aria-label="审图设置"]');
  await page.waitForSelector('.settings-review-back');
  await page.evaluate(() => { window.reviewFixture.hold = false; window.reviewFixture.release(); });
  await page.waitForFunction(() => window.reviewFixture.photos[0].rating === 4);
  await page.click('.settings-review-back');
  assert.equal(await page.locator('.photo-save-status').textContent(), "本机已保存");
  assert.equal(await page.locator('button[aria-label="4 星"]').getAttribute('aria-pressed'), 'true');
  await page.click('button[aria-label="3 星"]');
  await page.waitForFunction(() => document.querySelector('.photo-counter').textContent === '2 / 2');
  assert.equal(await page.evaluate(() => window.reviewFixture.photos[0].rating), 3);
}
