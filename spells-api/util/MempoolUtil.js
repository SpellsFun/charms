import mempoolJS from "@mempool/mempool.js";

const mempoolHost = 'idclub.mempool.space';
const strNetwork = 'mainnet';

const {
    bitcoin: {transactions},
} = mempoolJS({
    hostname: mempoolHost,
    network: strNetwork,
});

export async function getTxHex(txid) {
    return await transactions.getTxHex({txid});
}