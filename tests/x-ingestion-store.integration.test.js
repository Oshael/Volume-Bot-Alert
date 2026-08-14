process.env.NODE_ENV = 'test';

// Integration coverage for the two Bloco 3 data-layer contracts that carry real
// logic: x_post idempotency (a post re-seen on every poll must not duplicate,
// and post+media are transactional) and x_session active filtering (a disabled
// or quarantined session must never be handed to the pool).

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const xPost = require('../src/models/x-post');
const xSession = require('../src/models/x-session');
const stage124 = require('../src/utils/db-init-stage124');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const POST_ID = 'test-post-1';

async function mediaRows(postId) {
  const { rows } = await db.query(
    'SELECT media_index, media_url, media_type FROM x_post_media WHERE post_id = $1 ORDER BY media_index',
    [postId],
  );
  return rows;
}

async function cleanup() {
  await db.query("DELETE FROM x_post_media WHERE post_id LIKE 'test-%'");
  await db.query("DELETE FROM x_post WHERE post_id LIKE 'test-%'");
  await db.query("DELETE FROM x_session WHERE label LIKE 'test-%'");
}

describe('X ingestion store integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage124.init({ closePool: false });
  });

  beforeEach(cleanup);
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('savePost persists post and media in one shot', async () => {
    await xPost.savePost({
      post: { postId: POST_ID, authorRestId: '111', authorScreenName: 'toly', authorFollowers: 100, text: 'gm', postedAt: new Date().toISOString(), engagement: { likes: 5 } },
      media: [
        { mediaIndex: 0, mediaUrl: 'http://img/0', mediaType: 'photo' },
        { mediaIndex: 1, mediaUrl: 'http://img/1', mediaType: 'video' },
      ],
    });
    const { rows } = await db.query('SELECT author_followers, text FROM x_post WHERE post_id = $1', [POST_ID]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].author_followers, '100');
    assert.equal((await mediaRows(POST_ID)).length, 2);
  });

  it('re-seeing the same post updates the snapshot without duplicating', async () => {
    const base = { postId: POST_ID, authorRestId: '111', authorScreenName: 'toly', postedAt: new Date().toISOString() };
    await xPost.savePost({ post: { ...base, authorFollowers: 100, text: 'gm', engagement: { likes: 5 } }, media: [{ mediaIndex: 0, mediaUrl: 'http://img/0', mediaType: 'photo' }] });
    await xPost.savePost({ post: { ...base, authorFollowers: 250, text: 'gm edited', engagement: { likes: 40 } }, media: [{ mediaIndex: 0, mediaUrl: 'http://img/0b', mediaType: 'photo' }] });

    const { rows } = await db.query('SELECT author_followers, text, engagement FROM x_post WHERE post_id = $1', [POST_ID]);
    assert.equal(rows.length, 1, 'must not duplicate on re-seen post_id');
    assert.equal(rows[0].author_followers, '250');
    assert.equal(rows[0].text, 'gm edited');
    assert.equal(rows[0].engagement.likes, 40);
    const media = await mediaRows(POST_ID);
    assert.equal(media.length, 1);
    assert.equal(media[0].media_url, 'http://img/0b');
  });

  it('listActive returns only enabled, non-quarantined sessions', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.query(
      `INSERT INTO x_session (label, auth_token, ct0, enabled, quarantined_until) VALUES
         ('test-good', 'a', 'b', TRUE, NULL),
         ('test-expired-quar', 'a', 'b', TRUE, $1),
         ('test-quarantined', 'a', 'b', TRUE, $2),
         ('test-disabled', 'a', 'b', FALSE, NULL)`,
      [past, future],
    );

    const active = await xSession.listActive();
    const labels = active.filter((s) => s.label.startsWith('test-')).map((s) => s.label).sort();
    assert.deepEqual(labels, ['test-expired-quar', 'test-good']);
  });

  it('quarantine removes a session from the active set', async () => {
    await db.query("INSERT INTO x_session (label, auth_token, ct0, enabled) VALUES ('test-q', 'a', 'b', TRUE)");
    const { rows } = await db.query("SELECT id FROM x_session WHERE label = 'test-q'");
    const id = rows[0].id;
    assert.ok((await xSession.listActive()).some((s) => s.id === id));

    await xSession.quarantine(id, Date.now() + 60_000);
    assert.ok(!(await xSession.listActive()).some((s) => s.id === id));
  });
});
