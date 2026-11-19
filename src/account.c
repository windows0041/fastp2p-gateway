#include "store.h"
#include <ctype.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <stdio.h>
#include <string.h>

int gw_admin_make(struct gw_admin *admin, const char *user, const char *password) {
    if (!user || !*user || strlen(user) > 256 || !password || !*password || strlen(password) > 1024)
        return -1;
    for (const unsigned char *p = (const unsigned char *)user; *p; ++p)
        if (*p < 32 || *p == 127) return -1;
    memset(admin, 0, sizeof(*admin));
    strcpy(admin->user, user);
    admin->iterations = 600000;
    unsigned char secret[32];
    if (RAND_bytes(admin->salt, sizeof(admin->salt)) != 1 || RAND_bytes(secret, sizeof(secret)) != 1 ||
        PKCS5_PBKDF2_HMAC(password, (int)strlen(password), admin->salt, sizeof(admin->salt),
            (int)admin->iterations, EVP_sha256(), sizeof(admin->hash), admin->hash) != 1)
        return -1;
    for (size_t i = 0; i < sizeof(secret); ++i) snprintf(admin->secret + 2*i, 3, "%02x", secret[i]);
    OPENSSL_cleanse(secret, sizeof(secret));
    return 0;
}
int gw_admin_verify(const struct gw_admin *admin, const char *password) {
    if (!password || strlen(password) > 1024 || admin->iterations < 100000 || admin->iterations > 10000000)
        return 0;
    unsigned char hash[32];
    int ok = PKCS5_PBKDF2_HMAC(password, (int)strlen(password), admin->salt, sizeof(admin->salt),
        (int)admin->iterations, EVP_sha256(), sizeof(hash), hash) == 1 &&
        !CRYPTO_memcmp(hash, admin->hash, sizeof(hash));
    OPENSSL_cleanse(hash, sizeof(hash));
    return ok;
}
int gw_store_admin_read(sqlite3 *db, struct gw_admin *admin) {
    sqlite3_stmt *s = NULL;
    if (sqlite3_prepare_v2(db, "SELECT username,salt,password_hash,iterations,jwt_secret FROM admin WHERE id=1", -1, &s, NULL) != SQLITE_OK)
        return -1;
    int result = sqlite3_step(s), status = -1;
    if (result == SQLITE_DONE) status = 1;
    else if (result == SQLITE_ROW && sqlite3_column_bytes(s, 0) > 0 && sqlite3_column_bytes(s, 0) <= 256 &&
        sqlite3_column_bytes(s, 1) == 16 && sqlite3_column_bytes(s, 2) == 32 &&
        sqlite3_column_int(s, 3) >= 100000 && sqlite3_column_int(s, 3) <= 10000000 && sqlite3_column_bytes(s, 4) == 64) {
        memset(admin, 0, sizeof(*admin));
        memcpy(admin->user, sqlite3_column_text(s, 0), (size_t)sqlite3_column_bytes(s, 0));
        memcpy(admin->salt, sqlite3_column_blob(s, 1), 16);
        memcpy(admin->hash, sqlite3_column_blob(s, 2), 32);
        admin->iterations = (unsigned)sqlite3_column_int(s, 3);
        memcpy(admin->secret, sqlite3_column_text(s, 4), 64);
        status = 0;
    }
    sqlite3_finalize(s);
    return status;
}
int gw_store_admin_write(sqlite3 *db, const struct gw_admin *admin) {
    sqlite3_stmt *s = NULL;
    int ok = sqlite3_prepare_v2(db, "INSERT INTO admin(id,username,salt,password_hash,iterations,jwt_secret) VALUES(1,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,password_hash=excluded.password_hash,iterations=excluded.iterations,jwt_secret=excluded.jwt_secret", -1, &s, NULL) == SQLITE_OK;
    if (ok) {
        sqlite3_bind_text(s, 1, admin->user, -1, SQLITE_TRANSIENT);
        sqlite3_bind_blob(s, 2, admin->salt, sizeof(admin->salt), SQLITE_TRANSIENT);
        sqlite3_bind_blob(s, 3, admin->hash, sizeof(admin->hash), SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 4, (int)admin->iterations);
        sqlite3_bind_text(s, 5, admin->secret, -1, SQLITE_TRANSIENT);
        ok = sqlite3_step(s) == SQLITE_DONE;
    }
    sqlite3_finalize(s);
    return ok ? 0 : -1;
}

int gw_email_normalize(const char *input, char email[257]) {
    size_t length = strlen(input);
    const char *at = strchr(input, '@');
    if (length > 254 || !at || at == input || at - input > 64 ||
        input[0] == '.' || at[-1] == '.' || strstr(input, "..") || !strchr(at + 1, '.'))
        return -1;
    for (const unsigned char *p = (const unsigned char *)input; p < (const unsigned char *)at; ++p)
        if (*p >= 128 || (!isalnum(*p) && !strchr("._+-", *p)))
            return -1;
    const unsigned char *label = (const unsigned char *)at + 1;
    for (const unsigned char *p = label;; ++p) {
        if (*p == '.' || !*p) {
            if (p == label || p - label > 63 || *label == '-' || p[-1] == '-')
                return -1;
            if (!*p)
                break;
            label = p + 1;
        } else if (*p >= 128 || (!isalnum(*p) && *p != '-'))
            return -1;
    }
    for (size_t i = 0; i <= length; ++i)
        email[i] = (char)tolower((unsigned char)input[i]);
    return 0;
}

int gw_store_member_read(sqlite3 *db, const char *email, struct gw_member *member) {
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(db, "SELECT id,install_token,salt,password_hash,iterations,jwt_secret "
                           "FROM members WHERE email=?", -1, &statement, NULL) != SQLITE_OK)
        return -1;
    sqlite3_bind_text(statement, 1, email, -1, SQLITE_TRANSIENT);
    int row = sqlite3_step(statement), result = row == SQLITE_DONE ? 1 : -1;
    if (row == SQLITE_ROW && strlen(email) < sizeof(member->account.user) &&
        sqlite3_column_bytes(statement, 2) == 16 && sqlite3_column_bytes(statement, 3) == 32 &&
        sqlite3_column_bytes(statement, 5) == 64) {
        memset(member, 0, sizeof(*member));
        member->id = sqlite3_column_int64(statement, 0);
        member->token = (uint64_t)sqlite3_column_int64(statement, 1);
        strcpy(member->account.user, email);
        memcpy(member->account.salt, sqlite3_column_blob(statement, 2), 16);
        memcpy(member->account.hash, sqlite3_column_blob(statement, 3), 32);
        member->account.iterations = (unsigned)sqlite3_column_int(statement, 4);
        memcpy(member->account.secret, sqlite3_column_text(statement, 5), 64);
        result = 0;
    }
    sqlite3_finalize(statement);
    return result;
}

sqlite3_int64 gw_store_member_owner(sqlite3 *db, uint64_t token) {
    if (token < UINT64_C(1000000000000000) || token > UINT64_C(9999999999999999))
        return 0;
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(db, "SELECT id FROM members WHERE install_token=?", -1, &statement, NULL) != SQLITE_OK)
        return -1;
    sqlite3_bind_int64(statement, 1, (sqlite3_int64)token);
    int row = sqlite3_step(statement);
    sqlite3_int64 owner = row == SQLITE_ROW ? sqlite3_column_int64(statement, 0) : row == SQLITE_DONE ? 0 : -1;
    sqlite3_finalize(statement);
    return owner;
}

static void bind_credentials(sqlite3_stmt *statement, const struct gw_admin *a) {
    sqlite3_bind_blob(statement, 1, a->salt, sizeof(a->salt), SQLITE_TRANSIENT);
    sqlite3_bind_blob(statement, 2, a->hash, sizeof(a->hash), SQLITE_TRANSIENT);
    sqlite3_bind_int(statement, 3, (int)a->iterations);
    sqlite3_bind_text(statement, 4, a->secret, -1, SQLITE_TRANSIENT);
}

int gw_store_member_create(sqlite3 *db, const struct gw_admin *account, uint64_t admin_token) {
    const uint64_t span = UINT64_C(9000000000000000);
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        uint64_t token;
        if (RAND_bytes((unsigned char *)&token, sizeof(token)) != 1)
            return -1;
        if (token >= UINT64_MAX - UINT64_MAX % span)
            continue;
        token = UINT64_C(1000000000000000) + token % span;
        if (token == admin_token)
            continue;
        sqlite3_stmt *statement = NULL;
        if (sqlite3_prepare_v2(db, "INSERT INTO members(id,email,salt,password_hash,iterations,jwt_secret,install_token) "
                               "VALUES((SELECT coalesce(max(id),1)+1 FROM members),?5,?1,?2,?3,?4,?6) "
                               "ON CONFLICT(email) DO NOTHING", -1, &statement, NULL) != SQLITE_OK)
            return -1;
        bind_credentials(statement, account);
        sqlite3_bind_text(statement, 5, account->user, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(statement, 6, (sqlite3_int64)token);
        int step = sqlite3_step(statement);
        sqlite3_finalize(statement);
        if (step == SQLITE_DONE)
            return sqlite3_changes(db) ? 0 : 1;
        if (step != SQLITE_CONSTRAINT)
            return -1;
    }
    return -1;
}

int gw_store_member_password(sqlite3 *db, sqlite3_int64 owner, const struct gw_admin *account) {
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(db, "UPDATE members SET salt=?1,password_hash=?2,iterations=?3,jwt_secret=?4 "
                           "WHERE id=?5 AND email=?6", -1, &statement, NULL) != SQLITE_OK)
        return -1;
    bind_credentials(statement, account);
    sqlite3_bind_int64(statement, 5, owner);
    sqlite3_bind_text(statement, 6, account->user, -1, SQLITE_TRANSIENT);
    int ok = sqlite3_step(statement) == SQLITE_DONE && sqlite3_changes(db) == 1;
    sqlite3_finalize(statement);
    return ok ? 0 : -1;
}
