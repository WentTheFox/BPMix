// See IDiscordRpcCallback.aidl's doc - hand-rolled to match Discord's own
// compiled interface exactly.
package com.discord.socialsdk.rpc;

interface IDiscordRpcConnection {
    void sendFrame(String frame);
    void disconnect();
}
