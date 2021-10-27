/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    "use strict";
    var socketTimeout = RED.settings.socketTimeout || null;
    const msgQueueSize = RED.settings.tcpMsgQueueSize || 1000;
    const Denque = require('denque');
    var net = require('net');

    /**
     * Enqueue `item` in `queue`
     * @param {Denque} queue - Queue
     * @param {*} item - Item to enqueue
     * @private
     * @returns {Denque} `queue`
     */
    const enqueue = (queue, item) => {
        // drop msgs from front of queue if size is going to be exceeded
        if (queue.length === msgQueueSize) { queue.shift(); }
        queue.push(item);
        return queue;
    };

    /**
     * Shifts item off front of queue
     * @param {Deque} queue - Queue
     * @private
     * @returns {*} Item previously at front of queue
     */
    const dequeue = queue => queue.shift();

    function TcpGet(n) {
        RED.nodes.createNode(this, n);
        this.server = n.server;
        this.port = Number(n.port);
        this.out = n.out;
        this.splitc = n.splitc;
        this.model = n.model;
        this.addr_rd = Number(n.RD_Addr);
        this.num_rd = Number(n.RD_Num);
        this.addr_wr = Number(n.WR_Addr);
        this.num_wr = n.WR_Value;

        if (this.out === "immed") {
            this.splitc = -1;
            this.out = "time";
        }
        if (this.out !== "char") { this.splitc = Number(this.splitc); } else {
            if (this.splitc[0] == '\\') {
                this.splitc = parseInt(this.splitc.replace("\\n", 0x0A).replace("\\r", 0x0D).replace("\\t", 0x09).replace("\\e", 0x1B).replace("\\f", 0x0C).replace("\\0", 0x00));
            } // jshint ignore:line
            if (typeof this.splitc == "string") {
                if (this.splitc.substr(0, 2) == "0x") {
                    this.splitc = parseInt(this.splitc);
                } else {
                    this.splitc = this.splitc.charCodeAt(0);
                }
            } // jshint ignore:line
        }

        var node = this;

        var clients = {};

        this.on("input", function(msg, nodeSend, nodeDone) {
            var i = 0;
            if ((!Buffer.isBuffer(msg.payload)) && (typeof msg.payload !== "string")) {
                msg.payload = msg.payload.toString();
            }
            if (node.model == "write") {
                msg.payload = "WRS DM" + node.addr_wr + ".U" + " " + 1 + " " + node.num_wr + '\r\n';
            } else {
                msg.payload = "RDS DM" + node.addr_rd + ".U" + " " + node.num_rd + '\r\n';
            }

            var host = node.server || msg.host;
            var port = node.port || msg.port;

            // Store client information independently
            // the clients object will have:
            // clients[id].client, clients[id].msg, clients[id].timeout
            var connection_id = host + ":" + port;
            if (connection_id !== node.last_id) {
                node.status({});
                node.last_id = connection_id;
            }
            clients[connection_id] = clients[connection_id] || {
                msgQueue: new Denque(),
                connected: false,
                connecting: false
            };
            enqueue(clients[connection_id].msgQueue, { msg: msg, nodeSend: nodeSend, nodeDone: nodeDone });
            clients[connection_id].lastMsg = msg;

            if (!clients[connection_id].connecting && !clients[connection_id].connected) {
                var buf;
                if (this.out == "count") {
                    if (this.splitc === 0) { buf = Buffer.alloc(1); } else { buf = Buffer.alloc(this.splitc); }
                } else { buf = Buffer.alloc(65536); } // set it to 64k... hopefully big enough for most TCP packets.... but only hopefully

                clients[connection_id].client = net.Socket();
                if (socketTimeout !== null) { clients[connection_id].client.setTimeout(socketTimeout); }

                if (host && port) {
                    clients[connection_id].connecting = true;
                    clients[connection_id].client.connect(port, host, function() {
                        //node.log(RED._("tcpin.errors.client-connected"));
                        node.status({ fill: "green", shape: "dot", text: "common.status.connected" });
                        if (clients[connection_id] && clients[connection_id].client) {
                            clients[connection_id].connected = true;
                            clients[connection_id].connecting = false;
                            let event;
                            while (event = dequeue(clients[connection_id].msgQueue)) {
                                clients[connection_id].client.write(event.msg.payload);
                                event.nodeDone();
                            }
                            if (node.out === "time" && node.splitc < 0) {
                                clients[connection_id].connected = clients[connection_id].connecting = false;
                                clients[connection_id].client.end();
                                delete clients[connection_id];
                                node.status({});
                            }
                        }
                    });
                } else {
                    node.warn(RED._("tcpin.errors.no-host"));
                }

                clients[connection_id].client.on('data', function(data) {
                    if (node.out === "sit") { // if we are staying connected just send the buffer
                        if (clients[connection_id]) {
                            const msg = clients[connection_id].lastMsg || {};
                            msg.payload = data;
                            nodeSend(RED.util.cloneMessage(msg));
                        }
                    }
                    // else if (node.splitc === 0) {
                    //     clients[connection_id].msg.payload = data;
                    //     node.send(clients[connection_id].msg);
                    // }
                    else {
                        for (var j = 0; j < data.length; j++) {
                            if (node.out === "time") {
                                if (clients[connection_id]) {
                                    // do the timer thing
                                    if (clients[connection_id].timeout) {
                                        i += 1;
                                        buf[i] = data[j];
                                    } else {
                                        clients[connection_id].timeout = setTimeout(function() {
                                            if (clients[connection_id]) {
                                                clients[connection_id].timeout = null;
                                                const msg = clients[connection_id].lastMsg || {};
                                                msg.payload = Buffer.alloc(i + 1);
                                                buf.copy(msg.payload, 0, 0, i + 1);
                                                nodeSend(msg);
                                                if (clients[connection_id].client) {
                                                    node.status({});
                                                    clients[connection_id].client.destroy();
                                                    delete clients[connection_id];
                                                }
                                            }
                                        }, node.splitc);
                                        i = 0;
                                        buf[0] = data[j];
                                    }
                                }
                            }
                            // count bytes into a buffer...
                            else if (node.out == "count") {
                                buf[i] = data[j];
                                i += 1;
                                if (i >= node.splitc) {
                                    if (clients[connection_id]) {
                                        const msg = clients[connection_id].lastMsg || {};
                                        msg.payload = Buffer.alloc(i);
                                        buf.copy(msg.payload, 0, 0, i);
                                        nodeSend(msg);
                                        if (clients[connection_id].client) {
                                            node.status({});
                                            clients[connection_id].client.destroy();
                                            delete clients[connection_id];
                                        }
                                        i = 0;
                                    }
                                }
                            }
                            // look for a char
                            else {
                                buf[i] = data[j];
                                i += 1;
                                if (data[j] == node.splitc) {
                                    if (clients[connection_id]) {
                                        const msg = clients[connection_id].lastMsg || {};
                                        msg.payload = Buffer.alloc(i);
                                        buf.copy(msg.payload, 0, 0, i);
                                        nodeSend(msg);
                                        if (clients[connection_id].client) {
                                            node.status({});
                                            clients[connection_id].client.destroy();
                                            delete clients[connection_id];
                                        }
                                        i = 0;
                                    }
                                }
                            }
                        }
                    }
                });

                clients[connection_id].client.on('end', function() {
                    //console.log("END");
                    node.status({ fill: "grey", shape: "ring", text: "common.status.disconnected" });
                    if (clients[connection_id] && clients[connection_id].client) {
                        clients[connection_id].connected = clients[connection_id].connecting = false;
                        clients[connection_id].client = null;
                    }
                });

                clients[connection_id].client.on('close', function() {
                    //console.log("CLOSE");
                    if (clients[connection_id]) {
                        clients[connection_id].connected = clients[connection_id].connecting = false;
                    }

                    var anyConnected = false;

                    for (var client in clients) {
                        if (clients[client].connected) {
                            anyConnected = true;
                            break;
                        }
                    }
                    if (node.doneClose && !anyConnected) {
                        clients = {};
                        node.doneClose();
                    }
                });

                clients[connection_id].client.on('error', function() {
                    //console.log("ERROR");
                    node.status({ fill: "red", shape: "ring", text: "common.status.error" });
                    node.error(RED._("tcpin.errors.connect-fail") + " " + connection_id, msg);
                    if (clients[connection_id] && clients[connection_id].client) {
                        clients[connection_id].client.destroy();
                        delete clients[connection_id];
                    }
                });

                clients[connection_id].client.on('timeout', function() {
                    //console.log("TIMEOUT");
                    if (clients[connection_id]) {
                        clients[connection_id].connected = clients[connection_id].connecting = false;
                        node.status({ fill: "grey", shape: "dot", text: "tcpin.errors.connect-timeout" });
                        //node.warn(RED._("tcpin.errors.connect-timeout"));
                        if (clients[connection_id].client) {
                            clients[connection_id].connecting = true;
                            clients[connection_id].client.connect(port, host, function() {
                                clients[connection_id].connected = true;
                                clients[connection_id].connecting = false;
                                node.status({ fill: "green", shape: "dot", text: "common.status.connected" });
                            });
                        }
                    }
                });
            } else if (!clients[connection_id].connecting && clients[connection_id].connected) {
                if (clients[connection_id] && clients[connection_id].client) {
                    let event = dequeue(clients[connection_id].msgQueue)
                    clients[connection_id].client.write(event.msg.payload);
                    event.nodeDone();
                }
            }
        });

        this.on("close", function(done) {
            node.doneClose = done;
            for (var cl in clients) {
                if (clients[cl].hasOwnProperty("client")) {
                    clients[cl].client.destroy();
                }
            }
            node.status({});

            // this is probably not necessary and may be removed
            var anyConnected = false;
            for (var c in clients) {
                if (clients[c].connected) {
                    anyConnected = true;
                    break;
                }
            }
            if (!anyConnected) { clients = {}; }
            done();
        });

    }
    RED.nodes.registerType("Keyence", TcpGet);
}