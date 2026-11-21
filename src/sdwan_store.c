#include "gateway.h"
#include <arpa/inet.h>
#include <string.h>

#define SDWAN_DEFAULT "10.3.2.0/24"
#define SDWAN_MAX_MEMBERS 33
#define SDWAN_MAX_ROUTES 128

static const char *text(json_object *object, const char *key) {
    json_object *value = gw_get(object, key);
    if (!json_object_is_type(value, json_type_string))
        return "";
    const char *string = json_object_get_string(value);
    return strlen(string) == (size_t)json_object_get_string_len(value) ? string : "";
}

static int ipv4(const char *value, uint32_t *address) {
    struct in_addr parsed;
    if (inet_pton(AF_INET, value, &parsed) != 1)
        return -1;
    *address = ntohl(parsed.s_addr);
    return *address < UINT32_C(0x01000000) || *address >> 24 == 127 ||
           *address >> 16 == UINT32_C(0xa9fe) || *address >= UINT32_C(0xe0000000) ? -1 : 0;
}

static uint32_t netmask(unsigned bits) {
    return UINT32_MAX << (32 - bits);
}

static int prefix(const char *text, uint32_t *address, unsigned *bits) {
    const char *slash = strchr(text, '/');
    char ip[INET_ADDRSTRLEN];
    if (!slash || slash == text || (size_t)(slash - text) >= sizeof(ip))
        return -1;
    memcpy(ip, text, (size_t)(slash - text));
    ip[slash - text] = 0;
    const char *width = slash + 1;
    if (*width < '1' || *width > '9')
        return -1;
    unsigned n = (unsigned)(*width++ - '0');
    if (*width >= '0' && *width <= '9')
        n = 10 * n + (unsigned)(*width++ - '0');
    if (*width || n > 32 || ipv4(ip, address) || (*address & ~netmask(n)))
        return -1;
    *bits = n;
    return 0;
}

static int member_index(json_object *members, const char *node) {
    for (size_t i = 0; i < json_object_array_length(members); ++i)
        if (!strcmp(text(json_object_array_get_idx(members, i), "node"), node))
            return (int)i;
    return -1;
}

json_object *gw_store_sdwan(sqlite3 *db, sqlite3_int64 owner) {
    sqlite3_stmt *s = NULL;
    if (sqlite3_prepare_v2(db, "SELECT plan FROM sdwan_networks WHERE owner=?", -1, &s, NULL) != SQLITE_OK)
        return NULL;
    sqlite3_bind_int64(s, 1, owner);
    int row = sqlite3_step(s);
    json_object *plan = NULL;
    if (row == SQLITE_ROW)
        plan = gw_json(sqlite3_column_text(s, 0), (size_t)sqlite3_column_bytes(s, 0));
    else if (row == SQLITE_DONE) {
        plan = json_object_new_object();
        gw_js(plan, "subnet", SDWAN_DEFAULT);
        json_object_object_add(plan, "members", json_object_new_array());
    }
    sqlite3_finalize(s);
    if (json_object_is_type(gw_get(plan, "members"), json_type_array))
        return plan;
    if (plan)
        json_object_put(plan);
    return NULL;
}

static const char *validate(sqlite3 *db, sqlite3_int64 owner, json_object *plan) {
    uint32_t subnet;
    unsigned bits;
    json_object *members = gw_get(plan, "members");
    if (!json_object_is_type(members, json_type_array) ||
        json_object_array_length(members) > SDWAN_MAX_MEMBERS)
        return "invalid SD-WAN member list";
    if (prefix(text(plan, "subnet"), &subnet, &bits) || bits > 30)
        return "invalid SD-WAN IPv4 subnet";
    uint32_t mask = netmask(bits), addresses[SDWAN_MAX_MEMBERS];
    struct { uint32_t network; unsigned bits; } exports[SDWAN_MAX_ROUTES];
    size_t count = json_object_array_length(members), exported = 0;
    for (size_t i = 0; i < count; ++i) {
        json_object *member = json_object_array_get_idx(members, i);
        const char *node = text(member, "node");
        if (!gw_node_valid(node) || gw_store_node_owner(db, node) != owner)
            return "SD-WAN member is not registered to this account";
        if (member_index(members, node) != (int)i)
            return "duplicate SD-WAN member";
        if (ipv4(text(member, "address"), &addresses[i]) || (addresses[i] & mask) != subnet ||
            addresses[i] == subnet || addresses[i] == (subnet | ~mask))
            return "invalid SD-WAN member address";
        for (size_t j = 0; j < i; ++j)
            if (addresses[j] == addresses[i])
                return "duplicate SD-WAN IPv4 address";
        json_object *routes = gw_get(member, "routes");
        if (!json_object_is_type(routes, json_type_array) ||
            json_object_array_length(routes) > SDWAN_MAX_ROUTES - count - exported)
            return "too many SD-WAN routes or invalid route list";
        for (size_t j = 0; j < json_object_array_length(routes); ++j) {
            json_object *entry = json_object_array_get_idx(routes, j);
            uint32_t network;
            unsigned width;
            if (!json_object_is_type(entry, json_type_string) ||
                strlen(json_object_get_string(entry)) != (size_t)json_object_get_string_len(entry) ||
                prefix(json_object_get_string(entry), &network, &width))
                return "invalid SD-WAN route prefix";
            uint32_t common = netmask(width < bits ? width : bits);
            if ((network & common) == (subnet & common))
                return "SD-WAN route overlaps the virtual subnet";
            for (size_t previous = 0; previous < exported; ++previous)
                if (exports[previous].network == network && exports[previous].bits == width)
                    return "duplicate SD-WAN route prefix";
            exports[exported].network = network;
            exports[exported++].bits = width;
        }
    }
    return NULL;
}

static int set_node(sqlite3 *db, const char *node, json_object *profile) {
    json_object *stored = gw_store_config(db, node), *previous = NULL;
    if (!stored)
        return -1;
    int same = json_object_object_get_ex(gw_get(stored, "fields"), "sdwan", &previous) &&
               json_object_equal(previous, profile) && strcmp(gw_string(stored, "state"), "failed");
    json_object_put(stored);
    if (same)
        return 0;
    json_object *patch = json_object_new_object();
    json_object_object_add(patch, "sdwan", json_object_get(profile));
    int result = gw_store_config_patch(db, node, patch);
    json_object_put(patch);
    return result;
}

static int project(sqlite3 *db, json_object *plan) {
    json_object *members = gw_get(plan, "members");
    size_t count = json_object_array_length(members);
    for (size_t i = 0; i < count; ++i) {
        json_object *member = json_object_array_get_idx(members, i);
        json_object *profile = NULL;
        if (count > 1) {
            profile = json_object_new_object();
            gw_js(profile, "Subnet", text(plan, "subnet"));
            gw_js(profile, "Address", text(member, "address"));
            json_object_object_add(profile, "LocalRoutes", json_object_get(gw_get(member, "routes")));
            json_object *peers = json_object_new_array();
            json_object_object_add(profile, "Peers", peers);
            for (size_t j = 0; j < count; ++j) {
                if (j == i)
                    continue;
                json_object *remote = json_object_array_get_idx(members, j);
                json_object *peer = json_object_new_object();
                gw_js(peer, "Node", text(remote, "node"));
                gw_js(peer, "Address", text(remote, "address"));
                json_object_object_add(peer, "Routes", json_object_get(gw_get(remote, "routes")));
                json_object_array_add(peers, peer);
            }
        }
        int result = set_node(db, text(member, "node"), profile);
        if (profile)
            json_object_put(profile);
        if (result)
            return -1;
    }
    return 0;
}

static int save(sqlite3 *db, sqlite3_int64 owner, json_object *plan) {
    sqlite3_stmt *s = NULL;
    const char *sql = "INSERT INTO sdwan_networks VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET plan=excluded.plan";
    if (sqlite3_prepare_v2(db, sql, -1, &s, NULL) != SQLITE_OK)
        return -1;
    sqlite3_bind_int64(s, 1, owner);
    sqlite3_bind_text(s, 2, json_object_to_json_string_ext(plan, JSON_C_TO_STRING_PLAIN), -1, SQLITE_TRANSIENT);
    int row = sqlite3_step(s);
    sqlite3_finalize(s);
    return row == SQLITE_DONE ? 0 : -1;
}

const char *gw_store_sdwan_put(sqlite3 *db, sqlite3_int64 owner, json_object *plan) {
    if (sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) != SQLITE_OK)
        return "SD-WAN storage unavailable";
    const char *error = validate(db, owner, plan);
    json_object *old = NULL, *normalized = NULL;
    if (error)
        goto done;
    error = "SD-WAN storage unavailable";
    old = gw_store_sdwan(db, owner);
    if (!old)
        goto done;
    normalized = json_object_new_object();
    gw_js(normalized, "subnet", text(plan, "subnet"));
    json_object *members = gw_get(plan, "members");
    json_object *new_members = json_object_new_array();
    json_object_object_add(normalized, "members", new_members);
    for (size_t i = 0; i < json_object_array_length(members); ++i) {
        json_object *input = json_object_array_get_idx(members, i), *member = json_object_new_object();
        gw_js(member, "node", text(input, "node"));
        gw_js(member, "address", text(input, "address"));
        json_object_object_add(member, "routes", json_object_get(gw_get(input, "routes")));
        json_object_array_add(new_members, member);
    }
    members = gw_get(old, "members");
    for (size_t i = 0; i < json_object_array_length(members); ++i) {
        const char *node = text(json_object_array_get_idx(members, i), "node");
        if (member_index(new_members, node) < 0 && gw_store_node_owner(db, node) == owner &&
            set_node(db, node, NULL))
            goto done;
    }
    if (!project(db, normalized) && !save(db, owner, normalized) &&
        sqlite3_exec(db, "COMMIT", NULL, NULL, NULL) == SQLITE_OK)
        error = NULL;
done:
    if (error)
        sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
    if (normalized)
        json_object_put(normalized);
    if (old)
        json_object_put(old);
    return error;
}

/* Called inside the device rename/delete transaction. */
int gw_store_sdwan_rebind(sqlite3 *db, sqlite3_int64 owner, const char *old_name, const char *new_name) {
    json_object *plan = gw_store_sdwan(db, owner);
    if (!plan)
        return -1;
    json_object *members = gw_get(plan, "members");
    int index = member_index(members, old_name), result = 0;
    if (index >= 0) {
        if (new_name)
            gw_js(json_object_array_get_idx(members, (size_t)index), "node", new_name);
        else
            json_object_array_del_idx(members, (size_t)index, 1);
        result = project(db, plan) || save(db, owner, plan);
    }
    json_object_put(plan);
    return result;
}
