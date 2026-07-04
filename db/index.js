import * as SQLite from "expo-sqlite";

let _db = null;
let _currentDbName = null;

// Proxy delegates every property access to the live _db instance so callers
// never need to update their import after initializeDatabase() fires.
export const db = new Proxy(
  {},
  {
    get(_, prop) {
      const val = _db?.[prop];
      return typeof val === "function" ? val.bind(_db) : val;
    },
  },
);

export function getCurrentDbName() {
  return _currentDbName;
}

export function initializeDatabase(userId) {
  const dbName = `cm_${userId}.db`;
  if (_currentDbName === dbName) return; // already open for this user
  _currentDbName = dbName;
  _db = SQLite.openDatabaseSync(dbName);
  _db.execSync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- App log + telemetry buffer. Doubles as the durable offline queue for the
    -- cloud log shipper: rows are written with Synced = 0 and flipped to 1 once
    -- batch-shipped to the cloud app_logs table. Event/Data carry success-
    -- telemetry (logEvent); SessionId groups one app launch.
    CREATE TABLE IF NOT EXISTS AppLogs (
      LogSk TEXT PRIMARY KEY NOT NULL,
      Level TEXT,
      Message TEXT,
      StackTrace TEXT,
      Context TEXT,
      Event TEXT,
      Data TEXT,
      SessionId TEXT,
      Synced INTEGER NOT NULL DEFAULT 0,
      CreatedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS Organizations (
      OrgSk     TEXT PRIMARY KEY NOT NULL,
      OrgName   TEXT,
      UserId    TEXT NOT NULL,
      CreatedAt INTEGER NOT NULL,
      Synced    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS Users (
      UserSk      TEXT PRIMARY KEY NOT NULL,
      UserId      TEXT UNIQUE,
      fname       TEXT,
      lname       TEXT,
      OrgSk       TEXT NOT NULL,
      Role        TEXT CHECK(Role IN ('admin', 'user')),
      UserProfile TEXT,
      _version INTEGER DEFAULT 1,
      _lastChangedAt INTEGER,
      _deleted BOOLEAN DEFAULT 0,
      Synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS Inspections (
      InspectionSk TEXT PRIMARY KEY NOT NULL,
      UserSk TEXT NOT NULL,
      FullName TEXT,
      Summary TEXT,
      AddressLine1 TEXT,
      AddressLine2 TEXT,
      City TEXT,
      State TEXT,
      ZipCode TEXT,
      ScheduledAt TEXT,
      Phone TEXT,
      Email TEXT,
      Longitude REAL,
      Latitude REAL,
      Status TEXT DEFAULT 'OPEN',
      HasApptReminder INTEGER NOT NULL DEFAULT 0,
      ApptReminderStatus TEXT DEFAULT 'PENDING',
      PaymentState TEXT NOT NULL DEFAULT 'none',
      ReportState TEXT NOT NULL DEFAULT 'pending',
      Paid INTEGER NOT NULL DEFAULT 0,
      ReportRecipients TEXT NOT NULL DEFAULT '[]',
      LastReportPath TEXT,
      LastReportAt INTEGER,
      CalendarEventId TEXT,
      CalendarOwnerDeviceId TEXT,
      CalendarSnapshot TEXT,
      _version INTEGER DEFAULT 1,
      _lastChangedAt INTEGER,
      _deleted BOOLEAN DEFAULT 0,
      Synced INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (UserSk) REFERENCES Users (UserSk)
    );

    CREATE TABLE IF NOT EXISTS DayCache (
      CacheKey TEXT PRIMARY KEY NOT NULL,
      Value TEXT NOT NULL,
      ExpiresAt INTEGER NOT NULL,
      CreatedAt INTEGER NOT NULL
    );

    -- Local cache of the org's PUBLISHED walkthrough template. Pull-only for
    -- everyone (members never push; the owner's authoritative copy is the
    -- cloud walkthrough_templates row), so no Synced column.
    CREATE TABLE IF NOT EXISTS WalkthroughTemplate (
      OrgSk            TEXT PRIMARY KEY NOT NULL,
      PublishedSchema  TEXT,
      PublishedVersion INTEGER NOT NULL DEFAULT 0,
      UpdatedAt        INTEGER
    );

    -- Per-inspection walkthrough form, 1:1 with Inspections. SchemaSnapshot
    -- freezes the template at create time; Answers is the filled JSON. Replaces
    -- InspectionDescription + InspectionDetail.
    CREATE TABLE IF NOT EXISTS InspectionForm (
      InspectionSk    TEXT PRIMARY KEY NOT NULL,
      SchemaSnapshot  TEXT,
      Answers         TEXT NOT NULL DEFAULT '{}',
      TemplateVersion INTEGER NOT NULL DEFAULT 0,
      _version        INTEGER DEFAULT 1,
      _lastChangedAt  INTEGER,
      _deleted        BOOLEAN DEFAULT 0,
      Synced          INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (InspectionSk) REFERENCES Inspections (InspectionSk)
    );

    CREATE TABLE IF NOT EXISTS SmsTemplate (
      SmsTemplateSk TEXT PRIMARY KEY NOT NULL,
      UserSk        TEXT NOT NULL,
      Name          TEXT NOT NULL DEFAULT '',
      Body          TEXT NOT NULL DEFAULT '',
      Position      INTEGER NOT NULL DEFAULT 0,
      CreatedAt     TEXT NOT NULL,
      UpdatedAt     TEXT NOT NULL,
      Synced        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS NotificationSettings (
      NotificationSk     TEXT PRIMARY KEY NOT NULL,
      UserId             TEXT NOT NULL,
      NotificationName   TEXT NOT NULL,
      IsNotificationOn   INTEGER NOT NULL DEFAULT 0,
      _version           INTEGER DEFAULT 1,
      _lastChangedAt     INTEGER,
      Synced             INTEGER NOT NULL DEFAULT 0,
      UNIQUE(UserId, NotificationName)
    );

    CREATE TABLE IF NOT EXISTS SmsStatus (
      SmsStatusSk   TEXT PRIMARY KEY NOT NULL,
      UserSk        TEXT NOT NULL,
      InspectionSk  TEXT NOT NULL,
      SmsTemplateSk TEXT NOT NULL,
      Sent          INTEGER NOT NULL DEFAULT 0,
      SentAt        INTEGER,
      _version      INTEGER DEFAULT 1,
      _lastChangedAt INTEGER,
      _deleted      BOOLEAN DEFAULT 0,
      Synced        INTEGER NOT NULL DEFAULT 0,
      UNIQUE(InspectionSk, SmsTemplateSk),
      FOREIGN KEY (InspectionSk) REFERENCES Inspections (InspectionSk)
    );
  `);

  // Patch existing databases — CREATE TABLE IF NOT EXISTS won't modify them.
  // Phase 6 cutover: drop the legacy relational form tables from any dev DB
  // that still has them. InspectionDetail (child) before InspectionDescription
  // to satisfy foreign_keys = ON; SectionTemplate is independent. Their data
  // moved to the InspectionForm JSON document model.
  try {
    _db.execSync(`DROP TABLE IF EXISTS InspectionDetail`);
  } catch (_) {}
  try {
    _db.execSync(`DROP TABLE IF EXISTS InspectionDescription`);
  } catch (_) {}
  try {
    _db.execSync(`DROP TABLE IF EXISTS SectionTemplate`);
  } catch (_) {}
  try {
    _db.execSync(`CREATE TABLE IF NOT EXISTS SmsTemplate (
      SmsTemplateSk TEXT PRIMARY KEY NOT NULL,
      UserSk        TEXT NOT NULL,
      Name          TEXT NOT NULL DEFAULT '',
      Body          TEXT NOT NULL DEFAULT '',
      Position      INTEGER NOT NULL DEFAULT 0,
      CreatedAt     TEXT NOT NULL,
      UpdatedAt     TEXT NOT NULL,
      Synced        INTEGER NOT NULL DEFAULT 0
    )`);
  } catch (_) {}
  try {
    _db.execSync(`CREATE TABLE IF NOT EXISTS Organizations (
      OrgSk     TEXT PRIMARY KEY NOT NULL,
      OrgName   TEXT,
      UserId    TEXT NOT NULL,
      CreatedAt INTEGER NOT NULL,
      Synced    INTEGER NOT NULL DEFAULT 0
    )`);
  } catch (_) {}
  try {
    _db.execSync(`ALTER TABLE Users ADD COLUMN UserProfile TEXT`);
  } catch (_) {}

  // One-time: pre-existing local DBs were created with
  // CHECK(UserProfile IN ('owner', 'member')) which now rejects 'admin'.
  // SQLite can't ALTER a CHECK constraint, so rebuild the table without it.
  try {
    const row = _db.getFirstSync(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'Users'`,
    );
    if ((row?.sql ?? "").includes("CHECK(UserProfile IN")) {
      _db.execSync(`
        PRAGMA foreign_keys = OFF;
        BEGIN TRANSACTION;
        CREATE TABLE Users_new (
          UserSk      TEXT PRIMARY KEY NOT NULL,
          UserId      TEXT UNIQUE,
          fname       TEXT,
          lname       TEXT,
          OrgSk       TEXT NOT NULL,
          Role        TEXT CHECK(Role IN ('admin', 'user')),
          UserProfile TEXT,
          _version INTEGER DEFAULT 1,
          _lastChangedAt INTEGER,
          _deleted BOOLEAN DEFAULT 0,
          Synced INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO Users_new (UserSk, UserId, fname, lname, OrgSk, Role, UserProfile, _version, _lastChangedAt, _deleted, Synced)
          SELECT UserSk, UserId, fname, lname, OrgSk, Role, UserProfile, _version, _lastChangedAt, _deleted, Synced FROM Users;
        DROP TABLE Users;
        ALTER TABLE Users_new RENAME TO Users;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch (e) {
    console.warn("[db] UserProfile CHECK rebuild skipped:", e?.message);
  }
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN Status TEXT DEFAULT 'OPEN'`,
    );
  } catch (_) {}
  // Device-local pointers to the last generated report PDF in the app
  // sandbox. Deliberately NOT synced — the file only exists on this device.
  try {
    _db.execSync(`ALTER TABLE Inspections ADD COLUMN LastReportPath TEXT`);
  } catch (_) {}
  try {
    _db.execSync(`ALTER TABLE Inspections ADD COLUMN LastReportAt INTEGER`);
  } catch (_) {}
  // Client appointment-reminder fields (synced). HasApptReminder is seeded from
  // the global "Text appointment reminder" setting at create time and overridable
  // per inspection; ApptReminderStatus is the day-before send tracker the reminder
  // job flips PENDING -> SENT.
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN HasApptReminder INTEGER NOT NULL DEFAULT 0`,
    );
  } catch (_) {}
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN ApptReminderStatus TEXT DEFAULT 'PENDING'`,
    );
  } catch (_) {}
  // Stripe Connect (Phase 0): synced per-inspection payment/report rollup state +
  // multi-recipient report-email array. PaymentState/ReportState/Paid are written
  // by the cloud reconciler/webhook and pulled down (the device never pushes
  // them); ReportRecipients is device-editable.
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN PaymentState TEXT NOT NULL DEFAULT 'none'`,
    );
  } catch (_) {}
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN ReportState TEXT NOT NULL DEFAULT 'pending'`,
    );
  } catch (_) {}
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN Paid INTEGER NOT NULL DEFAULT 0`,
    );
  } catch (_) {}
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN ReportRecipients TEXT NOT NULL DEFAULT '[]'`,
    );
  } catch (_) {}
  // Calendar two-way sync (synced, device-editable like ReportRecipients).
  // CalendarEventId = the owner device's local event id; CalendarOwnerDeviceId =
  // which Zanbi device manages the event (single-writer guard); CalendarSnapshot =
  // last-synced {title,start,end,location,notes,lastModified} JSON for diff +
  // conflict resolution + loop prevention.
  try {
    _db.execSync(`ALTER TABLE Inspections ADD COLUMN CalendarEventId TEXT`);
  } catch (_) {}
  try {
    _db.execSync(
      `ALTER TABLE Inspections ADD COLUMN CalendarOwnerDeviceId TEXT`,
    );
  } catch (_) {}
  try {
    _db.execSync(`ALTER TABLE Inspections ADD COLUMN CalendarSnapshot TEXT`);
  } catch (_) {}
  try {
    _db.execSync(`CREATE TABLE IF NOT EXISTS SmsStatus (
      SmsStatusSk   TEXT PRIMARY KEY NOT NULL,
      UserSk        TEXT NOT NULL,
      InspectionSk  TEXT NOT NULL,
      SmsTemplateSk TEXT NOT NULL,
      Sent          INTEGER NOT NULL DEFAULT 0,
      SentAt        INTEGER,
      _version      INTEGER DEFAULT 1,
      _lastChangedAt INTEGER,
      _deleted      BOOLEAN DEFAULT 0,
      Synced        INTEGER NOT NULL DEFAULT 0,
      UNIQUE(InspectionSk, SmsTemplateSk),
      FOREIGN KEY (InspectionSk) REFERENCES Inspections (InspectionSk)
    )`);
  } catch (_) {}

  // Patch in walkthrough-form tables for existing databases.
  try {
    _db.execSync(`CREATE TABLE IF NOT EXISTS WalkthroughTemplate (
      OrgSk            TEXT PRIMARY KEY NOT NULL,
      PublishedSchema  TEXT,
      PublishedVersion INTEGER NOT NULL DEFAULT 0,
      UpdatedAt        INTEGER
    )`);
  } catch (_) {}
  try {
    _db.execSync(`CREATE TABLE IF NOT EXISTS InspectionForm (
      InspectionSk    TEXT PRIMARY KEY NOT NULL,
      SchemaSnapshot  TEXT,
      Answers         TEXT NOT NULL DEFAULT '{}',
      TemplateVersion INTEGER NOT NULL DEFAULT 0,
      _version        INTEGER DEFAULT 1,
      _lastChangedAt  INTEGER,
      _deleted        BOOLEAN DEFAULT 0,
      Synced          INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (InspectionSk) REFERENCES Inspections (InspectionSk)
    )`);
  } catch (_) {}

  // Patch in NotificationSettings for existing databases.
  try {
    _db.execSync(`CREATE TABLE IF NOT EXISTS NotificationSettings (
      NotificationSk     TEXT PRIMARY KEY NOT NULL,
      UserId             TEXT NOT NULL,
      NotificationName   TEXT NOT NULL,
      IsNotificationOn   INTEGER NOT NULL DEFAULT 0,
      _version           INTEGER DEFAULT 1,
      _lastChangedAt     INTEGER,
      Synced             INTEGER NOT NULL DEFAULT 0,
      UNIQUE(UserId, NotificationName)
    )`);
  } catch (_) {}

  // Patch AppLogs for existing databases: telemetry + offline-shipper columns.
  for (const col of [
    "Event TEXT",
    "Data TEXT",
    "SessionId TEXT",
    "Synced INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      _db.execSync(`ALTER TABLE AppLogs ADD COLUMN ${col}`);
    } catch (_) {}
  }

  // Add Synced column to all sync-eligible tables
  const syncTables = [
    "Organizations",
    "Users",
    "Inspections",
    "InspectionForm",
    "SmsTemplate",
    "SmsStatus",
    "NotificationSettings",
  ];
  for (const table of syncTables) {
    try {
      _db.execSync(
        `ALTER TABLE ${table} ADD COLUMN Synced INTEGER NOT NULL DEFAULT 0`,
      );
    } catch (_) {}
  }

  // Mirror of the cloud's server_updated_at (epoch micros). The incremental
  // manifest-diff pull compares this against the cloud value to decide which
  // rows actually changed; 0 = never fetched/changed (forces a fetch on first
  // sight, then stays put while it matches the cloud's 0).
  const serverStampTables = [
    "Inspections",
    "InspectionForm",
    "SmsTemplate",
    "SmsStatus",
  ];
  for (const table of serverStampTables) {
    try {
      _db.execSync(
        `ALTER TABLE ${table} ADD COLUMN ServerUpdatedAt INTEGER NOT NULL DEFAULT 0`,
      );
    } catch (_) {}
  }
}
