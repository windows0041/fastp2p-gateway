#include "store.h"
#include "protocol.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static void bind_name_id(sqlite3_stmt *statement, const char *name) {
    char id[32];
    snprintf(id, sizeof(id), "%" PRIu64, gw_node_id(name));
    sqlite3_bind_text(statement, 1, name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(statement, 2, id, -1, SQLITE_TRANSIENT);
}

int gw_store_alias_reserved(sqlite3 *db, const char *name) {
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(db, "SELECT 1 FROM node_aliases WHERE name=?1 OR node_id=?2",
                          -1, &statement, NULL) != SQLITE_OK)
        return -1;
    bind_name_id(statement, name);
    int row = sqlite3_step(statement);
    sqlite3_finalize(statement);
    return row == SQLITE_ROW ? 1 : row == SQLITE_DONE ? 0 : -1;
}

int gw_store_alias_for(sqlite3 *db, sqlite3_int64 owner, const char *alias, char canonical[32]) {
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(db, "SELECT n.name FROM node_aliases a JOIN nodes n ON n.name=a.node "
                           "WHERE a.name=? AND n.owner=?", -1, &statement, NULL) != SQLITE_OK)
        return -1;
    sqlite3_bind_text(statement, 1, alias, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(statement, 2, owner);
    int row = sqlite3_step(statement);
    if (row == SQLITE_ROW)
        snprintf(canonical, 32, "%s", (const char *)sqlite3_column_text(statement, 0));
    sqlite3_finalize(statement);
    return row == SQLITE_ROW ? 1 : row == SQLITE_DONE ? 0 : -1;
}

static int rename_targets(json_object *obj, const char *old_name, const char *new_name) {
    const char *keys[] = {"peerNode", "relayNode", "PeerNode", "RelayNode"};
    int modified = 0;
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i)
        if (!strcmp(gw_string(obj, keys[i]), old_name)) {
            gw_js(obj, keys[i], new_name);
            modified = 1;
        }
    return modified;
}

static int rewrite_refs(sqlite3 *db, sqlite3_int64 owner, const char *old_name, const char *new_name,
                        int config) {
    const char *query = config ? "SELECT c.rowid,c.fields FROM node_configs c JOIN nodes n ON n.name=c.node WHERE n.owner=?" :
                                 "SELECT r.rowid,r.payload FROM rules r JOIN nodes n ON n.name=r.node WHERE n.owner=?";
    const char *update = config ? "UPDATE node_configs SET fields=?,revision=revision+1,state='queued' WHERE rowid=?" :
                                  "UPDATE rules SET payload=? WHERE rowid=?";
    sqlite3_stmt *read = NULL, *write = NULL;
    int result = -1;
    if (sqlite3_prepare_v2(db, query, -1, &read, NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(db, update, -1, &write, NULL) != SQLITE_OK)
        goto done;
    sqlite3_bind_int64(read, 1, owner);
    int row;
    while ((row = sqlite3_step(read)) == SQLITE_ROW) {
        json_object *value = gw_json(sqlite3_column_text(read, 1), (size_t)sqlite3_column_bytes(read, 1));
        if (!json_object_is_type(value, json_type_object)) {
            if (value) json_object_put(value);
            goto done;
        }
        int modified = 0;
        if (config) {
            const char *keys[] = {"apps", "socks5"};
            for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
                json_object *entries = gw_get(value, keys[i]);
                if (json_object_is_type(entries, json_type_array))
                    for (size_t k = 0; k < json_object_array_length(entries); ++k)
                        modified |= rename_targets(json_object_array_get_idx(entries, k), old_name, new_name);
            }
        } else {
            modified = rename_targets(value, old_name, new_name);
            modified |= rename_targets(gw_get(value, "_config"), old_name, new_name);
        }
        int written = SQLITE_DONE;
        if (modified) {
            sqlite3_bind_text(write, 1, json_object_to_json_string_ext(value, JSON_C_TO_STRING_PLAIN),
                              -1, SQLITE_TRANSIENT);
            sqlite3_bind_int64(write, 2, sqlite3_column_int64(read, 0));
            written = sqlite3_step(write);
            sqlite3_reset(write);
        }
        json_object_put(value);
        if (written != SQLITE_DONE)
            goto done;
    }
    if (row == SQLITE_DONE)
        result = 0;
done:
    sqlite3_finalize(write);
    sqlite3_finalize(read);
    return result;
}

int gw_store_rename(sqlite3 *db, sqlite3_int64 owner, const char *old_name, const char *new_name) {
    if (!gw_node_valid(old_name) || !gw_node_valid(new_name) ||
        sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) != SQLITE_OK)
        return -1;
    sqlite3_stmt *statement = NULL;
    int result = -1;
    if (sqlite3_prepare_v2(db, "SELECT rename_supported,device_id FROM nodes WHERE name=? AND owner=?",
                          -1, &statement, NULL) != SQLITE_OK)
        goto done;
    sqlite3_bind_text(statement, 1, old_name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(statement, 2, owner);
    int row = sqlite3_step(statement);
    if (row != SQLITE_ROW) {
        result = row == SQLITE_DONE ? 2 : -1;
        goto done;
    }
    int supported = sqlite3_column_int(statement, 0) || sqlite3_column_type(statement, 1) != SQLITE_NULL;
    sqlite3_finalize(statement);
    statement = NULL;
    if (!strcmp(old_name, new_name)) {
        result = 0;
        goto done;
    }
    if (!supported) {
        result = 3;
        goto done;
    }
    const char *conflict = "SELECT name,name FROM nodes WHERE name=?1 OR node_id=?2 "
                           "UNION ALL SELECT name,node FROM node_aliases WHERE name=?1 OR node_id=?2";
    if (sqlite3_prepare_v2(db, conflict, -1, &statement, NULL) != SQLITE_OK)
        goto done;
    bind_name_id(statement, new_name);
    while ((row = sqlite3_step(statement)) == SQLITE_ROW) {
        const char *alias = (const char *)sqlite3_column_text(statement, 0);
        const char *canonical = (const char *)sqlite3_column_text(statement, 1);
        if (strcmp(alias, new_name) || strcmp(canonical, old_name)) {
            result = 1;
            goto done;
        }
    }
    if (row != SQLITE_DONE)
        goto done;
    sqlite3_finalize(statement);
    statement = NULL;
    if (rewrite_refs(db, owner, old_name, new_name, 0) || rewrite_refs(db, owner, old_name, new_name, 1))
        goto done;
    const char *updates[] = {
        "DELETE FROM node_aliases WHERE name=?1 AND node=?3",
        "UPDATE nodes SET name=?1,node_id=?2,online=0 WHERE name=?3",
        "UPDATE rules SET node=?1 WHERE node=?3",
        "UPDATE rule_nodes SET node=?1 WHERE node=?3",
        "UPDATE node_configs SET node=?1 WHERE node=?3",
        "UPDATE node_aliases SET node=?1 WHERE node=?3",
        "INSERT INTO node_aliases(name,node_id,node) VALUES(?1,?2,?3)"
    };
    for (size_t i = 0; i < sizeof(updates) / sizeof(updates[0]); ++i) {
        if (sqlite3_prepare_v2(db, updates[i], -1, &statement, NULL) != SQLITE_OK)
            goto done;
        int inserting_alias = i + 1 == sizeof(updates) / sizeof(updates[0]);
        bind_name_id(statement, inserting_alias ? old_name : new_name);
        sqlite3_bind_text(statement, 3, inserting_alias ? new_name : old_name, -1, SQLITE_TRANSIENT);
        row = sqlite3_step(statement);
        sqlite3_finalize(statement);
        statement = NULL;
        if (row != SQLITE_DONE)
            goto done;
    }
    result = gw_store_sdwan_rebind(db, owner, old_name, new_name);
done:
    sqlite3_finalize(statement);
    if (!result && sqlite3_exec(db, "COMMIT", NULL, NULL, NULL) == SQLITE_OK)
        return 0;
    sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
    return result ? result : -1;
}
