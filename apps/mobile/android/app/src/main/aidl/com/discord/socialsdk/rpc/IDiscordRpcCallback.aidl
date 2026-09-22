// Hand-rolled to match the real Discord app's exposed IDiscordRpcService
// interface exactly (package + interface name determine the AIDL
// DESCRIPTOR string the Binder transaction is matched against, so this
// has to be byte-for-byte the same shape Discord itself compiled against -
// see DiscordRpcModule.kt's doc for how this was derived, by decompiling
// Discord's own official (but far heavier) Social SDK AAR rather than
// bundling it).
package com.discord.socialsdk.rpc;

interface IDiscordRpcCallback {
    void onFrame(String frame);
    void onClose(int code, String reason);
}
