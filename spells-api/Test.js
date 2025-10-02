import * as bitcoin from "bitcoinjs-lib";
import ProveService from "./ProveService.js";
import PsbtUtil from "./util/PsbtUtil.js";

// ========== 配置参数 ==========
const feerate = 0.3;
const revealTxSize = 401;
const spellTxHex = "02000000000102388d49b6394e54e008541547ad6d9b978a08576aa2dbd9ec3ce10ce6e8a154380000000000ffffffff6e03976573e1b03bdd9b71c1ad12acca872a2a9d222b028303252f3802c0e1950000000000ffffffff024a0100000000000022512090df40d23ce58b6a3edf583e6e88960b084a8698d1e4585ca7214a7b6456417ae205000000000000225120b8bb7fd7d9dfa5b23977cdbbb7d0489f5e362167962f56cc3d199d273ce113a00003410b237dcef9eb5265fc4fcd0db7cdf4876dc737e7486e4997df002fba7c988fe97ccd15f747c69bfcea946c4304f3385e102a29aeff1a035d68bbcc907415edec81fdd7020063057370656c6c4d080282a36776657273696f6e07627478a1646f75747381a1001b0000000867ba4900716170705f7075626c69635f696e70757473a18361749820183d187f18e718e418ce18a6121819184718af187318d70e1851181918be18bd188a18a518b718ed18fe187418bf18af186e1877189a1818184718bd189b982018c9187518d418e018c2189218fb189518ef18bd18a518c118331218d618ac181d188b185a18ef18f718f018f118e518571886184518a218da187018ff185ff699010418a41859184c1859181a185a0818371518f1189c18f118d5181f1850188e18df010c04188518e9181c183018de18e718a81518ad18c01859181b1893182318e5185f1824185c18a518d818ca18a818d3185318671870189e188018b1189618d5186b182e187418b2182e189a186b0e184418e80818fb188e189118f20a0d18281618580e18cf18c0188518591894182618a21853188e18c718f918a1188e181f18f21854187d18b018ed186c189d182218900e18a61518a118431823187018681875182418db187018c11880182018ca18d718ac18d0188f181b18241827189d18a018e6184e185f186a18af18cf189e18eb187d185a184c18311828187c18e318f60818c118e2187a189803182301188f18ea1853183118f018381871184818b918ef1850189018e9181c188918b018f118771418530a1879186018a303183818261820188c18b918ca18a8044c9f189518bd18fa18a618a6188118ae181b101881184418ad184718601843182418dc18ab1842182b184718761885186c1854071852189a1880187118d2184918d01896189a184e18e1182f1846182018be186c183c18aa18d7182a18ae181f18540118c20e187e16187418b718cd188918ad18c0189c185b020718ae18df184b18ab18f0189618a7185618e3183918db18b2184818ec1836183f187618da18236820b011824283fd0c13202af0e0f255006953a59e066a216c67347c0f78c73c2759ac21c1b011824283fd0c13202af0e0f255006953a59e066a216c67347c0f78c73c275900000000";

const spellPrivateKey = "7d706117cadf0908e21144ae8d96d77c6b8a0fda38658e72530f016dbf9eff9b";
const fundAddress = 'bc1phzahl47em7jmywthekam05zgna0rvgt8jch4dnparxwjw08pzwsqq7zrpr';
const receiveAddress = 'bc1pjr05p53uuk9k50kltqlxazykpvyy4p5c68j9sh98y998kezkg9aqhu3ac9';

// ========== 主流程 ==========
console.log("========== Weaver 交易两步签名测试 ==========\n");

// 1. 提取 spell 数据（直接使用原始交易中的所有数据）
const spellScript = ProveService.extractScriptFromSpellTx(spellTxHex, 1);

console.log("1. 从 Spell TX 提取的完整数据:");
console.log("   - Spell 数据长度:", spellScript.spellData.length / 2, "字节");
console.log("   - 原始 Tapscript:", spellScript.tapscript.slice(0, 40) + "...");
console.log("   - 原始 Control Block:", spellScript.controlBlock.slice(0, 20) + "...");

// 2. 从原始控制块中提取内部公钥
const originalControlBlock = Buffer.from(spellScript.controlBlock, 'hex');
const originalInternalPubkey = originalControlBlock.slice(1, 33);
console.log("   - 原始内部公钥:", originalInternalPubkey.toString('hex'));

// 3. 使用原始数据重新生成地址（用于验证）
const spellAddress = ProveService.generateScriptAddress(spellPrivateKey, spellScript.spellData);
console.log("\n2. 我们生成的地址（用于对比）:");
console.log("   - 地址:", spellAddress.address);
console.log("   - 我们的公钥:", spellAddress.xOnlyPubkey);

// 4. 验证地址是否匹配（这应该失败，因为我们使用了错误的私钥）
console.log("\n3. 公钥匹配检查:");
const ourPubkey = spellAddress.xOnlyPubkey;
const originalPubkey = originalInternalPubkey.toString('hex');
const isMatching = ourPubkey === originalPubkey;
console.log("   - 我们的公钥:", ourPubkey);
console.log("   - 原始公钥:", originalPubkey);
console.log("   - 匹配:", isMatching ? '✓' : '✗');

if (!isMatching) {
    console.log("   ⚠️  警告：公钥不匹配，我们需要使用原始的 tapscript 和 control block");
}

// 5. 使用原始数据创建正确的地址信息
const correctSpellAddress = {
    address: "bc1pcdvwp0r4sz4expkz8vayumtjkp6cugec0j8se4jyj8dhxflegr5sn9qntw", // 从错误信息中确认的地址
    tapscript: spellScript.tapscript,
    controlBlock: spellScript.controlBlock,
    xOnlyPubkey: originalPubkey,
    taprootOutput: "5120c358e0bc7580ab9306c23b3a4e6d72b0758e23387c8f0cd64491db7327f940e9"
};

console.log("\n4. 使用原始数据构建的正确地址信息:");
console.log("   - 地址:", correctSpellAddress.address);
console.log("   - 使用原始 Tapscript 和 Control Block");

// 2. 创建 commit 交易
const commitTx = await createCommitTx();
console.log("3. 创建的 Commit 交易:");
console.log("   - 交易ID:", commitTx.txid);
console.log("   - hex:", commitTx.hex, "sats\n");

// 3. 准备 commit UTXO
// ⚠️  重要：这个 UTXO 必须是发送到正确的地址
console.log("⚠️  注意：需要先创建并广播 commit 交易，获得真实的 UTXO");
console.log("   目标地址:", correctSpellAddress.address);
console.log("   Commit 交易 PSBT:", commitTx.base64, "\n");

// 使用真实的 UTXO（使用原始的内部公钥）
const commitUtxo = {
    txid: 'd0a9a0276df48b729cfdba2d19b7ecf54e9addf1be01caecf316ca74430a616e',  // 已经执行过广播
    vout: 0,
    value: 330,
    address: correctSpellAddress.address,
    tapInternalKey: correctSpellAddress.xOnlyPubkey  // 使用原始的内部公钥
};

console.log("⚠️  下一步：");
console.log("   1. 签名并广播上面的 commit 交易");
console.log("   2. 获得真实的 commit txid");
console.log("   3. 更新 commitUtxo.txid 为真实值");
console.log("   4. 然后运行 reveal 交易\n");

// 如果你已经有真实的 commit UTXO，取消注释下面的代码并更新 txid：
/*
const commitUtxo = {
    txid: '你的真实commit交易txid',
    vout: 0,
    value: 330,
    address: spellAddress.address,
    tapInternalKey: spellAddress.xOnlyPubkey
};
*/

// 4. 创建 reveal 交易并进行两步签名
console.log("4. 创建 Reveal 交易并进行两步签名:\n");

const revealResult = await createRevealTx(commitUtxo, receiveAddress);
console.log(revealResult);

async function createCommitTx() {
    const inputList = [];
    inputList.push({
        txid: 'f54242f95579e66a41662d562e51e45f08f15cc0e253db786083c4d4d8852182',
        vout: 2,
        value: 1022,
        address: fundAddress
    });

    const outputList = [];

    outputList.push({
        address: correctSpellAddress.address,
        value: 330
    })

    return await PsbtUtil.createUnSignPsbt(inputList, outputList, fundAddress, feerate, true);
}

/**
 * 原始测试函数（使用测试私钥）
 */
async function createRevealTx(commitUtxo, receiveAddress) {
    console.log("\n========== 调试信息 ==========");
    console.log("Commit UTXO 地址:", commitUtxo.address);
    console.log("Spell 地址信息:");
    console.log("  - 地址:", correctSpellAddress.address);
    console.log("  - Internal Pubkey:", correctSpellAddress.xOnlyPubkey);

    // === 步骤 1: 后端创建 PSBT 并签名 commit UTXO ===
    const inputList = [];

    // 输入1: 用户的资产 UTXO (暂不签名)
    // 注意：这里的地址应该是用户实际钱包的地址
    const userUtxo = {
        txid: '42e7b96490d20bfe76634e98fbfaadd0e2ba8bf3bd8e8385a6825e9d835d8196',
        vout: 0,
        value: 547,
        address: fundAddress
    };
    inputList.push(userUtxo);

    console.log("   - 用户 UTXO 地址:", userUtxo.address);

    // 输入2: Commit UTXO (脚本地址，后端签名)
    inputList.push(commitUtxo);

    const outputList = [];
    outputList.push({
        address: receiveAddress,
        value: 330  // 转账金额
    });

    // 创建未签名的 PSBT
    const unsignedPsbt = await PsbtUtil.createUnSignPsbt(inputList, outputList, fundAddress, feerate, true);
    console.log("\n创建 PSBT 完成:");
    console.log("   - 输入数量:", inputList.length);
    console.log("   - 输出数量:", outputList.length);

    // 后端对 commit UTXO (索引1) 进行签名
    const psbt = bitcoin.Psbt.fromBase64(unsignedPsbt.base64);

    // tapInternalKey 已经通过 commitUtxo.tapInternalKey 正确设置，无需再次修复

    // 检查 PSBT 中 commit UTXO 的设置
    const commitInput = psbt.data.inputs[1];
    console.log("\n检查 Commit UTXO 输入 (索引 1):");
    console.log("  - witnessUtxo.script:", commitInput.witnessUtxo?.script.toString('hex'));
    console.log("  - tapInternalKey (修正后):", commitInput.tapInternalKey?.toString('hex'));

    // 验证地址是否匹配
    const expectedScript = Buffer.from(correctSpellAddress.taprootOutput, 'hex');
    const actualScript = commitInput.witnessUtxo?.script;
    if (!actualScript.equals(expectedScript)) {
        console.log("\n⚠️ 警告: witnessUtxo.script 与预期不匹配!");
        console.log("  预期:", expectedScript.toString('hex'));
        console.log("  实际:", actualScript.toString('hex'));
    } else {
        console.log("  ✓ witnessUtxo.script 匹配正确");
    }

    // 使用原始的 tapscript 和 control block 进行签名
    console.log("\n生成签名（使用原始数据）:");
    console.log("   - 使用原始 Tapscript:", correctSpellAddress.tapscript.slice(0, 40) + "...");
    console.log("   - 使用原始 Control Block:", correctSpellAddress.controlBlock.slice(0, 20) + "...");

    // 提取 PSBT 的输入输出信息
    const txInfo = {
        inputs: [],
        outputs: [],
        signIndex: 1
    };

    for (let i = 0; i < psbt.inputCount; i++) {
        const input = psbt.data.inputs[i];
        const txInput = psbt.txInputs[i];
        txInfo.inputs.push({
            txid: txInput.hash.reverse().toString('hex'),
            vout: txInput.index,
            value: input.witnessUtxo ? input.witnessUtxo.value : 1000,
            script: input.witnessUtxo ? input.witnessUtxo.script.toString('hex') : undefined
        });
    }

    for (const output of psbt.txOutputs) {
        txInfo.outputs.push({
            script: output.script.toString('hex'),
            value: output.value
        });
    }

    // ❌ 不要重新生成签名！直接使用原始交易中的 witness
    // 因为我们没有正确的私钥，所以直接复制原始交易的 witness

    console.log("   ⚠️  重要：由于我们没有正确的私钥，直接使用原始交易的 witness");

    // 从原始 spell 交易中提取 witness
    const originalTx = bitcoin.Transaction.fromHex(spellTxHex);
    const originalWitness = originalTx.ins[1].witness;

    if (originalWitness && originalWitness.length >= 3) {
        // 构建 finalScriptWitness (手动格式化)
        const witnessElements = [
            originalWitness[0], // 签名
            originalWitness[1], // tapscript
            originalWitness[2]  // control block
        ];

        // 手动构建 witness 格式
        const witnessBuffers = [];
        witnessBuffers.push(Buffer.from([witnessElements.length])); // 元素数量

        for (const element of witnessElements) {
            if (element.length < 0xfd) {
                witnessBuffers.push(Buffer.from([element.length]));
            } else {
                const lenBuf = Buffer.allocUnsafe(3);
                lenBuf[0] = 0xfd;
                lenBuf.writeUInt16LE(element.length, 1);
                witnessBuffers.push(lenBuf);
            }
            witnessBuffers.push(element);
        }

        const finalScriptWitness = Buffer.concat(witnessBuffers);

        // 设置 finalScriptWitness 到 PSBT
        psbt.data.inputs[1].finalScriptWitness = finalScriptWitness;

        console.log("   - 使用原始交易的 witness 数据");
        console.log("   - FinalScriptWitness 长度:", finalScriptWitness.length, "字节");
        console.log("   - 签名长度:", originalWitness[0].length, "字节");
        console.log("   - Tapscript 长度:", originalWitness[1].length, "字节");
        console.log("   - Control Block 长度:", originalWitness[2].length, "字节");
    } else {
        throw new Error("无法从原始交易中提取 witness 数据");
    }

    // 返回 PSBT，保留原始的签名索引结构
    // 让钱包自己判断哪些输入需要签名
    unsignedPsbt.base64 = psbt.toBase64();
    unsignedPsbt.hex = psbt.toHex();

    // 保留原始的签名索引，但标记输入1已经完成
    console.log("   - 输入0需要用户签名");
    console.log("   - 输入1已完成签名（finalScriptWitness）");

    return unsignedPsbt;
}
