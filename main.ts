/**
 * makecode ZETag module Package Release 3.1
 * Original: Masakazu Urade (Tipyman) 2026/01/28
 */

//% weight=100 color=#32CD32 icon="\uf482" block="ZETag R3.1"
namespace ZETag_R31 {

    // -----------------------------
    // Constants & Types
    // -----------------------------

    const txBuffer = pins.createBuffer(1);

    // Frame types
    const CMD_MAC = 0x01;
    const CMD_VERSION = 0x02;
    const CMD_SET_TX_MODE = 0x40; // 周波数/チャネル構成
    const CMD_TX_POWER = 0x41; // 送信電力
    const CMD_RADIO_PARAM = 0x42; // 無線パラメータ（変調・SR・CR）
    const CMD_OP_MODE = 0x44; // 動作モード（透過/テスト）
    const CMD_CH_SPACE_SET = 0xF0; // チャネル間隔（設定）
    const CMD_CH_SPACE_QRY = 0xF1; // チャネル間隔（応答/クエリ）
    const CMD_APP_DATA = 0x80; // アプリデータ送信
    const CMD_ERROR = 0xFF; // エラーフィードバック

    // Sub mode for CMD_SET_TX_MODE (0x40)
    const SUB_SINGLE = 0x00; // 1ch（短縮）
    const SUB_MULTI = 0x01; // 2ch以上（汎用）

    // Rx status
    export enum RxStatus {
        OK = 0xFF, // 正常応答
        TIMEOUT = 1,    // 受信タイムアウト
        SIZE_ERR = 2,    // サイズ不一致
        ZETAG_ERR = 3,    // ZETag側エラー(TYPE=0xFF)
        CHECKSUM_ERR = 4,    // チェックサム不一致/Type突合不一致
        FORMAT_ERR = 5     // フォーマット不正
    }

    // --- UI enums ---
    export enum ChSpace {
        //% block="100"
        KHz100 = 100,
        //% block="200"
        KHz200 = 200
    }
    export enum ChNum {
        //% block="1"
        _1 = 1,
        //% block="2"
        _2 = 2,
        //% block="3"
        _3 = 3,
        //% block="4"
        _4 = 4,
        //% block="5"
        _5 = 5,
        //% block="6"
        _6 = 6,
    }
    export enum TxPower {
        //% block="2"
        dBm2 = 2,
        //% block="4"
        dBm4 = 4,
        //% block="6"
        dBm6 = 6,
        //% block="8"
        dBm8 = 8,
        //% block="10"
        dBm10 = 10,
    }
    export enum Mode {
        //% block="4FSK(600sps,1/2)"
        FSK4 = 0,
        //% block="(予約)8FSK"
        FSK8 = 1 // 仕様未定義のため送信値は 0x01 に固定
    }
    export enum OP_Mode {
        //% block="Normal"
        Normal = 0,
        //% block="Test"
        Test = 1
    }

    // -----------------------------
    // Low-level helpers
    // -----------------------------

    /** TX one byte (0..255) */
    function UART_BIN_TX(txData: number): void {
        txBuffer.setUint8(0, txData & 0xFF);
        serial.writeBuffer(txBuffer);
    }

    /** RX one byte (blocking); returns 0..255 */
    function UART_BIN_RX(): number {
        const rxBuffer = serial.readBuffer(1); // blocking
        if (rxBuffer.length > 0) return rxBuffer[0] & 0xFF;
        return 0;
    }

    /** Sum of bytes (8-bit) */
    function checksum8(bytes: number[]): number {
        let sum = 0;
        for (let i = 0; i < bytes.length; i++) sum = (sum + (bytes[i] & 0xFF)) & 0xFF;
        return sum & 0xFF;
    }

    /**
     * Receive: FF 00 LEN [Type..(LEN-1 bytes)] CRC
     * 戻り: [status(=0xFF), 0x00, LEN, Type, ..., CRC] or [RxStatus.*]
     */
    function receive_query(): number[] {
        let timeoutCounter = 0;

        // sync FF
        while (true) {
            const d = UART_BIN_RX();
            if (d === 0xFF) break;
            if (++timeoutCounter > 15) return [RxStatus.TIMEOUT];
        }

        // expect 00
        const b1 = UART_BIN_RX();
        if (b1 !== 0x00) return [RxStatus.FORMAT_ERR];

        // read LEN
        const len = UART_BIN_RX() & 0xFF;
        if (len < 2) return [RxStatus.FORMAT_ERR]; // 最小: Type(1)+CRC(1)

        // read (LEN-1) bytes (Type + Data...)
        const typeAndData: number[] = [];
        for (let i = 0; i < len - 1; i++) typeAndData.push(UART_BIN_RX() & 0xFF);

        // read CRC
        const crc = UART_BIN_RX() & 0xFF;

        // verify checksum
        const calc = checksum8([0xFF, 0x00, len].concat(typeAndData));
        if (calc !== crc) return [RxStatus.CHECKSUM_ERR];

        // OK
        return [RxStatus.OK, 0x00, len].concat(typeAndData).concat([crc]);
    }

    /**
     * sendCommand: [FF,00,LEN, Type, ...payload..., CRC]
     * LEN = 1(Type) + payload.length + 1(CRC)
     */

    function sendCommand(type: number, payload: number[] = []): number[] {
        const len = 1 + payload.length + 1;
        const header = [0xFF, 0x00, len, type];
        const crc = checksum8(header.concat(payload));

        const frame = header.concat(payload);
        frame.push(crc); // ← ここがポイント

        for (let i = 0; i < frame.length; i++) UART_BIN_TX(frame[i]);

        return receive_query();
    }

    // -----------------------------
    // Public APIs
    // -----------------------------

    /**
     * 完成済みフレームをそのまま送信→受信
     * queryData[0] = RxStatus
     */
    //% blockId=Send_ZETag_command block="Send ZETag command %txArray"
    //% group="Send data" weight=95 blockGap=8
    export function Send_ZETag_command(txArray: number[]): number[] {
        for (let i = 0; i < txArray.length; i++) UART_BIN_TX(txArray[i] & 0xFF);

        const rsp = receive_query();
        if (rsp[0] !== RxStatus.OK) return rsp;

        const reqType = txArray[3] & 0xFF;
        const rspType = rsp[3] & 0xFF;

        // 例外: F0(設定)→F1(応答)を許容
        const okType =
            (rspType === reqType) ||
            (reqType === CMD_CH_SPACE_SET && rspType === CMD_CH_SPACE_QRY);

        // エラーフレーム TYPE=0xFF
        if (rspType === CMD_ERROR) {
            rsp[0] = RxStatus.ZETAG_ERR;
            return rsp;
        }

        if (!okType) rsp[0] = RxStatus.CHECKSUM_ERR;
        return rsp;
    }

    /**
     * アプリケーションデータ送信 (0x80), N<=30
     */
    //% blockId=Transmit_ZETag_data block="Transmit ZETag data %dataArray"
    //% group="Send data" weight=95 blockGap=8
    export function Transmit_ZETag_data(txArray: number[]): void {
        if (!txArray || txArray.length < 1) return;
        let n = txArray.length;
        if (n > 30) n = 30; // 仕様上限

        const payload = txArray.slice(0, n);
        const rsp = sendCommand(CMD_APP_DATA, payload);
        // 応答は 0x80 0x81（成功） or 0xFF（エラー）
    }

    /**
     * バージョン取得 (0x02)
     * 戻り: 上位4bit=メイン、下位4bit=サブ
     */
    //% blockId=Get_Protocol_Version block="Get Protocol Version"
    //% subcategory="Other" weight=95 blockGap=8
    export function Get_Protocol_Version(): number {
        const rsp = sendCommand(CMD_VERSION, []); // payloadなし
        if (rsp[0] !== RxStatus.OK) return 0;

        const main = rsp[4] & 0x0F;
        const sub = rsp[5] & 0x0F;
        return ((main << 4) | sub) & 0xFF;
    }

    /**
     * 動作モード設定 (0x44)
     * Normal: FF 00 03 44 00 46
     * Test  : FF 00 05 44 01 [periodHi] [periodLo] CRC
     */
    //% blockId=Set_Operating_Mode block="Set Operating Mode %mode"
    //% subcategory="Other" weight=95 blockGap=8
    //% mode.min=0 mode.max=1 mode.defl=0
    export function Set_Operating_Mode(mode: OP_Mode): void {
        if (mode === OP_Mode.Test) {
            // 既定周期1秒：別ブロック setTestMode() で任意指定可
            sendCommand(CMD_OP_MODE, [0x01, 0x00, 0x01]);
        } else {
            // 透過（パススルー）
            sendCommand(CMD_OP_MODE, [0x00]);
        }
    }

    /**
     * 送信電力設定 (0x41)
     * 0.5dB/step, 0x10=8dBm, 0x14=10dBm
     */
    //% blockId=Set_TX_Power block="Set TX Power %txPower (dB)"
    //% subcategory="Other" weight=95 blockGap=8
    //% txPower.min=1 txPower.max=10 txPower.defl=10
    export function Set_TX_Power(txPower: number): void {
        if (txPower < 1) txPower = 1;
        if (txPower > 10) txPower = 10;
        const reg = (txPower * 2) & 0xFF;
        sendCommand(CMD_TX_POWER, [reg]);
    }

    /**
     * チャネル間隔設定 (0xF0), 応答は 0xF1
     */
    //% blockId=Set_channel_spacing block="Set channel spacing %chSpace (kHz)"
    //% subcategory="Other" weight=95 blockGap=8
    //% chSpace.min=100 chSpace.max=200 chSpace.defl=100
    export function Set_channel_spacing(chSpace: number): void {
        if (chSpace < 100) chSpace = 100;
        if (chSpace > 200) chSpace = 200;
        sendCommand(CMD_CH_SPACE_SET, [chSpace & 0xFF]);
    }

    /**
     * 周波数設定 (0x40)
     * 1ch:   0x40 0x00 [Freq4B]
     * 2..6ch:0x40 0x01 [Freq4B] [chNum] [channelNumbers...]
     */
    //% blockId=Set_Frequency block="Set Frequency %frequency (Hz) %chNum (ch) %chStep"
    //% subcategory="Other" weight=95 blockGap=8
    //% frequency.min=470000000 frequency.max=928000000 frequency.defl=922080000
    //% chNum.min=1 chNum.max=6 chNum.defl=2
    //% chStep.min=100 chStep.max=200 chStep.defl=100
    export function Set_Frequency(frequency: number, chNum: number, chStep: number): void {
        // clip
        if (chNum < 1) chNum = 1;
        if (chNum > 6) chNum = 6;
        if (chStep < 1) chStep = 1;
        if (chStep > 2) chStep = 2;

        // region clip（運用帯: 470–510MHz / 920–928MHz）
        if (frequency < 470000000) frequency = 470000000;
        else if (frequency > 928000000) frequency = 928000000;

        const f3 = (frequency >>> 24) & 0xFF;
        const f2 = (frequency >>> 16) & 0xFF;
        const f1 = (frequency >>> 8) & 0xFF;
        const f0 = (frequency) & 0xFF;

        if (chNum === 1) {
            // single channel (short)
            const payload = [SUB_SINGLE, f3, f2, f1, f0];
            sendCommand(CMD_SET_TX_MODE, payload);
        } else {
            // multi channel
            const payload: number[] = [SUB_MULTI, f3, f2, f1, f0, chNum];
            for (let n = 0; n < chNum; n++) payload.push((n * chStep) & 0xFF);
            sendCommand(CMD_SET_TX_MODE, payload);
        }
    }

    /**
     * 無線パラメータ設定 (0x42)
     * 仕様上 0x01=4FSK+600sps+1/2 のみ明記。FSK8 は予約。
     */
    //% blockId=Set_TX_Mode block="Set TX Mode %txMode"
    //% subcategory="Other" weight=95 blockGap=8
    //% txMode.defl=Mode.FSK4
    export function Set_TX_Mode(txMode: Mode): void {
        if (txMode === Mode.FSK4)
            sendCommand(CMD_RADIO_PARAM, [0x01]);	//4FSK
        else
            sendCommand(CMD_RADIO_PARAM, [0x10]);	//8FSK
    }

    // --- まとめ設定ブロック ---
    /**
     * ZETag の無線設定一括適用
     */
    //% blockId=zetag_setting
    //% block="ZETag Setting|Frequency(Hz) %frequency|Band width(kHz) %chSpace|Number of Channel(ch) %chNum|Tx Power(dB) %txPower|Mode %mode"
    //% group="ZETag Setting" weight=95 blockGap=8
    //% frequency.min=470000000 frequency.max=928000000 frequency.defl=922080000
    //% chSpace.defl=ChSpace.KHz200
    //% chNum.defl=ChNum._2
    //% txPower.defl=TxPower.dBm8
    //% mode.defl=Mode.FSK4
    export function applySetting(
        frequency: number,
        chSpace: ChSpace,
        chNum: ChNum,
        txPower: TxPower,
        mode: Mode
    ): void {
        // 0) 無線パラメータ（変調等）
        Set_TX_Mode(mode);

        // 1) チャネル間隔（例: 作法として 100kHz に固定）
        Set_channel_spacing(ChSpace.KHz100);

        // 2) 送信電力
        Set_TX_Power(txPower);

        // 3) 周波数＋チャネル
        const chStep = (chSpace === ChSpace.KHz200) ? 2 : 1;
        Set_Frequency(frequency, chNum, chStep);
    }
}