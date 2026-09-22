// See IDiscordRpcCallback.aidl's doc - hand-rolled to match Discord's own
// compiled interface exactly. This is the entry point: bind to it (action
// "com.discord.socialsdk.rpc.IDiscordRpcService" in package "com.discord" -
// see DiscordRpcModule.kt), then call connect() to get an
// IDiscordRpcConnection back.
package com.discord.socialsdk.rpc;

import com.discord.socialsdk.rpc.IDiscordRpcConnection;
import com.discord.socialsdk.rpc.IDiscordRpcCallback;

interface IDiscordRpcService {
    // origin is always the literal string "1" (the RPC version, matching
    // the classic desktop IPC handshake's {"v":1,...}) - confirmed by
    // decompiling the official SDK's own DiscordRpcClient, which hardcodes
    // this same literal.
    IDiscordRpcConnection connect(long applicationId, String origin, IDiscordRpcCallback callback);
}
