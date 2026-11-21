#include "gateway.h"
#include "config_merge.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void sdwan_members_follow_device_lifecycle(sqlite3 *db) {
    char assigned[32];
    assert(!gw_store_claim_for(db, 1, "", "mesh-node-a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, assigned));
    assert(!strcmp(assigned, "mesh-node-a"));
    assert(!gw_store_claim_for(db, 1, "mesh-node-b", "", "", 0, assigned));
    assert(!gw_store_claim_for(db, 2, "outside-node", "", "", 0, assigned));
    json_object *graph = json_tokener_parse("{\"subnet\":\"10.3.2.0/24\",\"members\":["
        "{\"node\":\"mesh-node-a\",\"address\":\"10.3.2.1\",\"routes\":[\"192.168.15.0/24\"]},"
        "{\"node\":\"mesh-node-b\",\"address\":\"10.3.2.2\",\"routes\":[]}]}");
    json_object *members = gw_get(graph, "members");
    gw_js(json_object_array_get_idx(members, 1), "node", "outside-node");
    assert(gw_store_sdwan_put(db, 1, graph));
    json_object *stored = gw_store_sdwan(db, 1);
    assert(!json_object_array_length(gw_get(stored, "members")));
    json_object_put(stored);
    gw_js(json_object_array_get_idx(members, 1), "node", "mesh-node-b");
    assert(!gw_store_sdwan_put(db, 1, graph));
    stored = gw_store_sdwan(db, 1);
    assert(!strcmp(gw_string(stored, "mode"), "mesh"));
    json_object_put(stored);
    gw_js(graph, "mode", "central");
    gw_js(graph, "center", "mesh-node-b");
    assert(!gw_store_sdwan_put(db, 1, graph));
    assert(gw_store_sdwan_elect(db, 1, "outside-node"));
    assert(!gw_store_sdwan_elect(db, 1, "mesh-node-a"));
    assert(!gw_store_sdwan_put(db, 1, graph)); /* Saving the same preference retains the elected center. */
    assert(!gw_store_rename(db, 1, "mesh-node-a", "mesh-renamed"));
    stored = gw_store_config(db, "mesh-node-b");
    json_object *profile = gw_get(gw_get(stored, "fields"), "sdwan");
    json_object *peer = json_object_array_get_idx(gw_get(profile, "Peers"), 0);
    assert(!strcmp(gw_string(peer, "Node"), "mesh-renamed"));
    assert(!strcmp(gw_string(profile, "Mode"), "central"));
    assert(!strcmp(gw_string(profile, "Center"), "mesh-renamed"));
    json_object_put(stored);
    assert(!gw_store_delete_offline(db, "mesh-renamed"));
    stored = gw_store_config(db, "mesh-node-b");
    assert(json_object_object_get_ex(gw_get(stored, "fields"), "sdwan", &profile) && profile == NULL);
    json_object_put(stored);
    json_object_put(graph);
}

int main(void) {
    char path[]="/tmp/fastp2p-config-store-XXXXXX";int fd=mkstemp(path);assert(fd>=0);close(fd);
    sqlite3 *db=NULL;assert(!gw_store_open(&db,path));
    json_object *a=json_tokener_parse("{\"nested\":{\"keep\":1,\"change\":2},\"array\":[1,2],\"local\":true}"),
                *b=json_tokener_parse("{\"nested\":{\"change\":3},\"array\":[4],\"null\":null}"),*merged=NULL;
    assert(!fp_config_merge(a,b,&merged));
    assert(gw_integer(gw_get(merged,"nested"),"keep")==1&&gw_integer(gw_get(merged,"nested"),"change")==3);
    assert(json_object_array_length(gw_get(merged,"array"))==1&&json_object_get_boolean(gw_get(merged,"local")));
    assert(gw_integer(gw_get(a,"nested"),"change")==2);json_object_put(merged);
    assert(!gw_store_config_put(db,"config-store-node",a));
    assert(!gw_store_config_put(db,"config-store-node",b));
    json_object *stored=gw_store_config(db,"config-store-node");assert(gw_integer(stored,"revision")==2);
    assert(gw_integer(gw_get(gw_get(stored,"fields"),"nested"),"keep")==1);json_object_put(stored);
    assert(!gw_store_config_ack(db,"config-store-node",2,"applied"));
    assert(!gw_store_config_ack(db,"config-store-node",1,"failed")); /* stale ACK cannot replace new status */
    stored=gw_store_config(db,"config-store-node");assert(!strcmp(gw_string(stored,"state"),"applied"));json_object_put(stored);
    json_object *rules=json_tokener_parse("{\"apps\":[{\"AppName\":\"ssh\",\"Protocol\":\"tcp\",\"SrcPort\":23322,\"PeerNode\":\"test-peer-node\",\"DstHost\":\"localhost\",\"DstPort\":22,\"custom\":{\"keep\":42}}]}");
    assert(!gw_store_config_put(db,"config-store-node",rules));assert(!gw_store_config_rules(db,"config-store-node"));
    stored=gw_store_config(db,"config-store-node");
    json_object *entry=json_object_array_get_idx(gw_get(gw_get(stored,"fields"),"apps"),0);
    assert(gw_integer(gw_get(entry,"custom"),"keep")==42);json_object_put(stored);
    json_object *bad=json_tokener_parse("{\"apps\":[{\"SrcPort\":1,\"Protocol\":\"invalid\"}]}");
    assert(gw_store_config_put(db,"config-store-node",bad)==-1);
    stored=gw_store_rules(db,"config-store-node");assert(json_object_array_length(stored)==1);json_object_put(stored);
    sdwan_members_follow_device_lifecycle(db);
    json_object_put(a);json_object_put(b);json_object_put(rules);json_object_put(bad);sqlite3_close(db);
    assert(!gw_store_open(&db,path));stored=gw_store_config(db,"config-store-node");assert(gw_integer(stored,"revision")>=3);
    json_object_put(stored);sqlite3_close(db);unlink(path);
    puts("Recursive key merge, arrays, unknown fields, transactional rules and stale ACK protection passed");return 0;
}
