// shared_seed_users.js - the platform's demo login credentials, in one place so every
// property's seed script (seed.js, seed_wingfield.js, ...) and the shared auth database
// (data/auth.db, seeded from server.js on boot) all agree on the same users.
//
// Why user rows exist in BOTH auth.db and every property db: login/password verification only
// ever reads from auth.db (see server.js's /login route), but each property db's own local
// `users` table still needs matching id/username rows too, purely so its own audit_log.user_id
// foreign key has something to point at when that property is being browsed - see server.js's
// audit() helper, which always writes into whichever property db is currently active.
const crypto = require('crypto');

const DEMO_USERS = [
  ['admin', 'admin123', 'admin', 'System Administrator'],
  ['billing', 'billing123', 'billing', 'Billing Clerk'],
  ['reviewer', 'reviewer123', 'reviewer', 'Billing Reviewer'],
  ['viewer', 'viewer123', 'readonly', 'Read Only User'],
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

// Idempotent: only inserts if the target db's users table is empty, and always inserts
// DEMO_USERS in the same fixed order, so AUTOINCREMENT ids line up 1:1 across auth.db and every
// property db.
function seedUsers(db) {
  const existing = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (existing > 0) return false;
  for (const [username, pw, role, full_name] of DEMO_USERS) {
    const { salt, hash } = hashPassword(pw);
    db.prepare('INSERT INTO users (username, password_hash, salt, role, full_name) VALUES (?,?,?,?,?)')
      .run(username, hash, salt, role, full_name);
  }
  return true;
}

module.exports = { seedUsers, hashPassword, DEMO_USERS };
