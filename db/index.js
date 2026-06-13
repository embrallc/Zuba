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

    CREATE TABLE IF NOT EXISTS AppLogs (
      LogSk TEXT PRIMARY KEY NOT NULL,
      Level TEXT,
      Message TEXT,
      StackTrace TEXT,
      Context TEXT,
      CreatedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS SectionTemplate (
        SectionTemplateSk TEXT PRIMARY KEY NOT NULL,
        UserSk TEXT NOT NULL,
        Name TEXT NOT NULL,
        Position INTEGER NOT NULL DEFAULT 0,
        CreatedAt TEXT NOT NULL,
        UpdatedAt TEXT NOT NULL,
        Synced INTEGER NOT NULL DEFAULT 0
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
      LastReportPath TEXT,
      LastReportAt INTEGER,
      _version INTEGER DEFAULT 1,
      _lastChangedAt INTEGER,
      _deleted BOOLEAN DEFAULT 0,
      Synced INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (UserSk) REFERENCES Users (UserSk)
    );

    CREATE TABLE IF NOT EXISTS InspectionDescription (
      InspectionDescriptionSk TEXT PRIMARY KEY NOT NULL,
      InspectionSk TEXT NOT NULL,
      Description TEXT,
      Notes TEXT,
      Position INTEGER DEFAULT 0,
      SeverityLevel TEXT DEFAULT NULL,
      _version INTEGER DEFAULT 1,
      _lastChangedAt INTEGER,
      _deleted BOOLEAN DEFAULT 0,
      Synced INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (InspectionSk) REFERENCES Inspections (InspectionSk)
    );

    CREATE TABLE IF NOT EXISTS InspectionDetail (
      InspectionDetailSk TEXT PRIMARY KEY NOT NULL,
      InspectionDescriptionSk TEXT NOT NULL,
      LocalPictureURI TEXT,
      CloudPictureURI TEXT,
      PictureNote TEXT,
      PictureMarkup TEXT,
      _version INTEGER DEFAULT 1,
      _lastChangedAt INTEGER,
      _deleted BOOLEAN DEFAULT 0,
      Synced INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (InspectionDescriptionSk) REFERENCES InspectionDescription (InspectionDescriptionSk)
    );

    CREATE TABLE IF NOT EXISTS DayCache (
      CacheKey TEXT PRIMARY KEY NOT NULL,
      Value TEXT NOT NULL,
      ExpiresAt INTEGER NOT NULL,
      CreatedAt INTEGER NOT NULL
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

  // Patch existing databases — CREATE TABLE IF NOT EXISTS won't modify them
  try {
    _db.execSync(
      `ALTER TABLE InspectionDescription ADD COLUMN Position INTEGER DEFAULT 0`,
    );
  } catch (_) {}
  try {
    _db.execSync(`ALTER TABLE InspectionDescription ADD COLUMN Notes TEXT`);
  } catch (_) {}
  try {
    _db.execSync(
      `ALTER TABLE InspectionDescription ADD COLUMN SeverityLevel TEXT DEFAULT NULL`,
    );
  } catch (_) {}
  try {
    _db.execSync(`CREATE TABLE IF NOT EXISTS SectionTemplate (
      SectionTemplateSk TEXT PRIMARY KEY NOT NULL,
      UserSk TEXT NOT NULL,
      Name TEXT NOT NULL,
      Position INTEGER NOT NULL DEFAULT 0,
      CreatedAt TEXT NOT NULL,
      UpdatedAt TEXT NOT NULL,
      Synced INTEGER NOT NULL DEFAULT 0
    )`);
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
  try {
    _db.execSync(
      `ALTER TABLE InspectionDetail RENAME COLUMN PictureURI TO LocalPictureURI`,
    );
  } catch (_) {}
  try {
    _db.execSync(
      `ALTER TABLE InspectionDetail ADD COLUMN CloudPictureURI TEXT`,
    );
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

  // Add Synced column to all sync-eligible tables
  const syncTables = [
    "Organizations",
    "Users",
    "Inspections",
    "InspectionDescription",
    "InspectionDetail",
    "SectionTemplate",
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
}
