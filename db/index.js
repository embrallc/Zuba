import * as SQLite from "expo-sqlite";

const db = SQLite.openDatabaseSync("clientmanagement.db");

export function initializeDatabase() {
  db.execSync(`
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
      UserProfile TEXT CHECK(UserProfile IN ('owner', 'member')),
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
      PictureURI TEXT,
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
    db.execSync(
      `ALTER TABLE InspectionDescription ADD COLUMN Position INTEGER DEFAULT 0`,
    );
  } catch (_) {}
  try {
    db.execSync(`ALTER TABLE InspectionDescription ADD COLUMN Notes TEXT`);
  } catch (_) {}
  try {
    db.execSync(
      `ALTER TABLE InspectionDescription ADD COLUMN SeverityLevel TEXT DEFAULT NULL`,
    );
  } catch (_) {}
  try {
    db.execSync(`CREATE TABLE IF NOT EXISTS SectionTemplate (
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
    db.execSync(`CREATE TABLE IF NOT EXISTS SmsTemplate (
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
    db.execSync(`CREATE TABLE IF NOT EXISTS Organizations (
      OrgSk     TEXT PRIMARY KEY NOT NULL,
      OrgName   TEXT,
      UserId    TEXT NOT NULL,
      CreatedAt INTEGER NOT NULL,
      Synced    INTEGER NOT NULL DEFAULT 0
    )`);
  } catch (_) {}
  try {
    db.execSync(`ALTER TABLE Users ADD COLUMN UserProfile TEXT CHECK(UserProfile IN ('owner', 'member'))`);
  } catch (_) {}
  try {
    db.execSync(`ALTER TABLE Inspections ADD COLUMN Status TEXT DEFAULT 'OPEN'`);
  } catch (_) {}
  try {
    db.execSync(`CREATE TABLE IF NOT EXISTS SmsStatus (
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
  ];
  for (const table of syncTables) {
    try {
      db.execSync(`ALTER TABLE ${table} ADD COLUMN Synced INTEGER NOT NULL DEFAULT 0`);
    } catch (_) {}
  }
}

export { db };

