const CC_BURN_REQUESTS = require('./test_fixtures/ccBurnRequests.json');
require('dotenv').config({path: "../../.env"});

import {expect} from "chai";
import {deployments, ethers} from "hardhat";
import {Signer, BigNumber} from "ethers";
import {deployMockContract, MockContract} from "@ethereum-waffle/mock-contract";
import {Address} from "hardhat-deploy/types";
import {Contract} from "@ethersproject/contracts";

import {CoreBTCLogic} from "../src/types/CoreBTCLogic";
import {CoreBTCLogic__factory} from "../src/types/factories/CoreBTCLogic__factory";
import {CoreBTCProxy} from "../src/types/CoreBTCProxy";
import {CoreBTCProxy__factory} from "../src/types/factories/CoreBTCProxy__factory";
import {Erc20} from "../src/types/ERC20";
import {Erc20__factory} from "../src/types/factories/Erc20__factory";

import {BurnRouterLib} from "../src/types/BurnRouterLib";
import {BurnRouterLib__factory} from "../src/types/factories/BurnRouterLib__factory";

import {BurnRouterProxy__factory} from "../src/types/factories/BurnRouterProxy__factory";
import {BurnRouterLogic__factory} from "../src/types/factories/BurnRouterLogic__factory";
import {BurnRouterLogicLibraryAddresses} from "../src/types/factories/BurnRouterLogic__factory";

import {takeSnapshot, revertProvider} from "./block_utils";
import {network} from "hardhat"

describe("BurnRouter", async () => {
    let snapshotId: any;

    // Accounts
    let proxyAdmin: Signer;
    let deployer: Signer;
    let signer1: Signer;
    let signer2: Signer;
    let signer1Address: Address;
    let signer2Address: Address;
    let deployerAddress: Address;
    let proxyAdminAddress: Address;

    // Contracts
    let coreBTC: CoreBTCLogic;
    let inputToken: Erc20;
    let inputTokenSigner1: Erc20;
    let CoreBTCSigner1: CoreBTCLogic;
    let burnRouterLib: BurnRouterLib;
    let burnRouter: Contract;
    let burnRouterSigner1: Contract;
    let burnRouterSigner2: Contract;

    // Mock contracts
    let mockBitcoinRelay: MockContract;
    let mockLockers: MockContract;

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000011";
    let oneHundred = BigNumber.from(10).pow(8).mul(100)
    /*
        This one is set so that:
        userRequestedAmount * (1 - lockerFee / 10000 - PROTOCOL_PERCENTAGE_FEE / 10000) - BITCOIN_FEE = 100000000
    */
    let userRequestedAmount = 14000;
    let burnAmount = 10000;
    let TRANSFER_DEADLINE = 20
    let PROTOCOL_PERCENTAGE_FEE = 5 // means 0.05%
    let LOCKER_PERCENTAGE_FEE = 15
    let SLASHER_PERCENTAGE_REWARD = 500 // means 5%
    let BITCOIN_FEE = 100 // estimation of Bitcoin transaction fee in Satoshi
    let TREASURY = "0x0000000000000000000000000000000000000002";

    let LOCKER_TARGET_ADDRESS = ONE_ADDRESS;
    let LOCKER1_LOCKING_SCRIPT = '0x76a914e1c5ba4d1fef0a3c7806603de565929684f9c2b188ac';

    let USER_SCRIPT_P2PKH = "0x574fdd26858c28ede5225a809f747c01fcc1f92a";
    let USER_SCRIPT_P2PKH_TYPE = 1; // P2PKH
    let USER_SCRIPT_P2WPKH = "0xfe138aced14a5e7187d0fdd3b3dc651cc2a11693";
    let USER_SCRIPT_P2WPKH_TYPE = 3; // P2WPKH

    before(async () => {

        [proxyAdmin, deployer, signer1, signer2] = await ethers.getSigners();
        proxyAdminAddress = await proxyAdmin.getAddress();
        signer1Address = await signer1.getAddress();
        signer2Address = await signer2.getAddress();
        deployerAddress = await deployer.getAddress();

        // Mocks contracts

        const bitcoinRelay = await deployments.getArtifact(
            "IBitcoinRelay"
        );
        mockBitcoinRelay = await deployMockContract(
            deployer,
            bitcoinRelay.abi
        )

        const lockers = await deployments.getArtifact(
            "LockersLogic"
        );
        mockLockers = await deployMockContract(
            deployer,
            lockers.abi
        )
        // mock finalization parameter
        await mockBitcoinRelay.mock.finalizationParameter.returns(5);

        // Deploys contracts
        coreBTC = await deployCoreBTC();
        burnRouter = await deployBurnRouter();

        await burnRouter.initialize(
            1,
            mockBitcoinRelay.address,
            mockLockers.address,
            TREASURY,
            coreBTC.address,
            TRANSFER_DEADLINE,
            PROTOCOL_PERCENTAGE_FEE,
            SLASHER_PERCENTAGE_REWARD,
            BITCOIN_FEE
        );

        // Deploys input token
        const erc20Factory = new Erc20__factory(deployer);
        inputToken = await erc20Factory.deploy(
            "TestToken",
            "TT",
            100000
        );
        inputTokenSigner1 = await inputToken.connect(signer1);

        // Mints CoreBTC for user
        await coreBTC.addMinter(signer1Address)
        CoreBTCSigner1 = await coreBTC.connect(signer1);

        await coreBTC.setMaxMintLimit(oneHundred.mul(2));
        await moveBlocks(2020)

        await CoreBTCSigner1.mint(signer1Address, oneHundred);

        // Connects signer1 and signer2 to burnRouter
        burnRouterSigner1 = await burnRouter.connect(signer1);
        burnRouterSigner2 = await burnRouter.connect(signer2)
    });

    async function moveBlocks(amount: number) {
        for (let index = 0; index < amount; index++) {
            await network.provider.request({
                method: "evm_mine",
                params: [],
            })
        }
    }

    const deployCoreBTC = async (
        _signer?: Signer
    ): Promise<CoreBTCLogic> => {
        const coreBTCLogicFactory = new CoreBTCLogic__factory(
            _signer || deployer
        );
        const coreBTCLogicImpl = await coreBTCLogicFactory.deploy();

        const coreBTCProxyFactory = new CoreBTCProxy__factory(
            _signer || deployer
        );

        const tokenName = "Core Wrapped BTC";
        const tokenSymbol = "CoreBTC";
        const methodSig = ethers.utils.id(
            "initialize(string,string)"
        );
        const params = ethers.utils.defaultAbiCoder.encode(
            ['string', 'string'],
            [tokenName, tokenSymbol]
        );

        const initCode = ethers.utils.solidityPack(
            ['bytes', 'bytes'],
            [methodSig.slice(0, 10), params]
        );

        const coreBTCProxy = await coreBTCProxyFactory.deploy(
            coreBTCLogicImpl.address,
            initCode
        )

        const coreBTCLogic = await coreBTCLogicFactory.attach(
            coreBTCProxy.address
        );

        return coreBTCLogic;
    };

    const deployBurnRouterLib = async (
        _signer?: Signer
    ): Promise<BurnRouterLib> => {
        const BurnRouterLibFactory = new BurnRouterLib__factory(
            _signer || deployer
        );

        const burnRouterLib = await BurnRouterLibFactory.deploy(
        );

        return burnRouterLib;
    };

    const deployBurnRouter = async (
        _signer?: Signer
    ): Promise<Contract> => {
        burnRouterLib = await deployBurnRouterLib()
        let linkLibraryAddresses: BurnRouterLogicLibraryAddresses;

        linkLibraryAddresses = {
            "contracts/libraries/BurnRouterLib.sol:BurnRouterLib": burnRouterLib.address,
        };

        // Deploys lockers logic
        const burnRouterLogicFactory = new BurnRouterLogic__factory(
            linkLibraryAddresses,
            _signer || deployer
        );

        const burnRouterLogic = await burnRouterLogicFactory.deploy();

        // Deploys lockers proxy
        const burnRouterProxyFactory = new BurnRouterProxy__factory(
            _signer || deployer
        );
        const burnRouterProxy = await burnRouterProxyFactory.deploy(
            burnRouterLogic.address,
            "0x"
        )

        return await burnRouterLogic.attach(
            burnRouterProxy.address
        );

    };

    async function setLockersSlashIdleLockerReturn(): Promise<void> {
        await mockLockers.mock.slashIdleLocker
            .returns(true);
    }

    async function setLockersSlashThiefLockerReturn(): Promise<void> {
        await mockLockers.mock.slashThiefLocker
            .returns(true);
    }

    async function setLockersIsLocker(isLocker: boolean): Promise<void> {
        await mockLockers.mock.isLocker
            .returns(isLocker);
    }

    async function setLockersGetLockerTargetAddress(): Promise<void> {
        await mockLockers.mock.getLockerTargetAddress
            .returns(LOCKER_TARGET_ADDRESS);
    }

    async function setLockersBurnReturn(burntAmount: number): Promise<void> {
        await mockLockers.mock.burn
            .returns(burntAmount);
    }

    async function setRelayLastSubmittedHeight(blockNumber: number): Promise<void> {
        await mockBitcoinRelay.mock.lastSubmittedHeight.returns(blockNumber);
    }

    async function setRelayCheckTxProofReturn(isFinal: boolean): Promise<void> {
        await mockBitcoinRelay.mock.checkTxProof.returns(isFinal);
    }

    async function mintCoreBTCForTest(): Promise<void> {
        let CoreBTCSigner1 = await coreBTC.connect(signer1)
        await CoreBTCSigner1.mint(signer1Address, oneHundred);
    }

    async function sendBurnRequest(
        burnReqBlockNumber: number,
        _userRequestedAmount: number,
        USER_SCRIPT: any,
        USER_SCRIPT_TYPE: any
    ): Promise<number> {
        // Gives allowance to burnRouter
        await CoreBTCSigner1.approve(
            burnRouter.address,
            _userRequestedAmount
        );

        // Sets mock contracts outputs
        await setRelayLastSubmittedHeight(burnReqBlockNumber);
        await setLockersIsLocker(true);
        let _burntAmount: number;
        let remainingAmount: number;
        let protocolFee = Math.floor(_userRequestedAmount * PROTOCOL_PERCENTAGE_FEE / 10000);
        remainingAmount = _userRequestedAmount - protocolFee;
        let lockersFee = Math.floor(remainingAmount * LOCKER_PERCENTAGE_FEE / 10000);
        _burntAmount = remainingAmount - lockersFee;
        await setLockersBurnReturn(_burntAmount);
        let burntAmount = _burntAmount * (_burntAmount - BITCOIN_FEE) / _burntAmount;


        await setLockersGetLockerTargetAddress();

        await expect(await burnRouterSigner1.ccBurn(
            _userRequestedAmount,
            USER_SCRIPT,
            USER_SCRIPT_TYPE,
            LOCKER1_LOCKING_SCRIPT
        )).to.emit(burnRouterSigner1, 'CCBurn');
        return burntAmount;
    }

    async function provideProof(burnReqBlockNumber: number) {

        // Set mocks contracts outputs
        await setRelayCheckTxProofReturn(true);
        await setLockersIsLocker(true);
        let burntAmount: number;
        let remainingAmount: number;
        let protocolFee = Math.floor(userRequestedAmount * PROTOCOL_PERCENTAGE_FEE / 10000);
        remainingAmount = userRequestedAmount - protocolFee;
        let lockersFee = Math.floor(userRequestedAmount * LOCKER_PERCENTAGE_FEE / 10000);
        burntAmount = remainingAmount - lockersFee;
        await setLockersBurnReturn(burntAmount);
        await setLockersGetLockerTargetAddress();
        // Provide proof that the locker has paid the burnt amount to the user(s)
        await expect(
            await burnRouterSigner2.burnProof(
                CC_BURN_REQUESTS.burnProof_valid.tx,
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                1,
                LOCKER1_LOCKING_SCRIPT,
                [0],
                [0]
            )
        ).to.emit(burnRouter, "PaidCCBurn")
    }

    describe("#ccBurn", async () => {

        beforeEach(async () => {
            // Gives allowance to burnRouter to burn tokens
            await CoreBTCSigner1.approve(
                burnRouter.address,
                userRequestedAmount
            );
            snapshotId = await takeSnapshot(signer1.provider);

        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Reverts since user script length is incorrect", async function () {
            // Sets mock contracts outputs
            await setLockersIsLocker(true);

            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH + "00",
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: invalid script")
            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH.slice(0, -2),
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: invalid script")
            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2WPKH + "00",
                    USER_SCRIPT_P2WPKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: invalid script")
            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2WPKH.slice(0, -2),
                    USER_SCRIPT_P2WPKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: invalid script")

            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH,
                    4,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: invalid script")

        })
        it("User Script Type Length is Correct", async function () {
            await burnRouter.setProtocolPercentageFee(0)
            let lastSubmittedHeight = 100;
            let USER_SCRIPT_P2TR = "0x96c0dd2bcc276600b96296e421f0778c2c75e9ad43dc117f699d8f76afffdb3c"
            let USER_SCRIPT_P2TR_TYPE = 5
            let USER_SCRIPT_P2SH_P2WPKH = "0x96c0dd2bcc276600b96296e421f0778c2c75e9ad43dc117f699d8f76afffdb3c"
            let USER_SCRIPT_P2SH_P2WPKH_TYPE = 2
            await CoreBTCSigner1.approve(
                burnRouter.address,
                userRequestedAmount
            );
            await setRelayLastSubmittedHeight(lastSubmittedHeight);
            await setLockersIsLocker(true);
            await setLockersBurnReturn(userRequestedAmount);
            await setLockersGetLockerTargetAddress();
            await burnRouterSigner1.ccBurn(
                userRequestedAmount,
                USER_SCRIPT_P2WPKH,
                USER_SCRIPT_P2WPKH_TYPE,
                LOCKER1_LOCKING_SCRIPT
            )
            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2WPKH,
                    USER_SCRIPT_P2WPKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.not.revertedWith("BurnRouter: invalid script")
            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.not.revertedWith("BurnRouter: invalid script")
            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2TR,
                    USER_SCRIPT_P2TR_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.not.revertedWith("BurnRouter: invalid script")
            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2SH_P2WPKH,
                    USER_SCRIPT_P2SH_P2WPKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.not.revertedWith("BurnRouter: invalid script")
        })
        it("Burns coreBTC for user", async function () {
            let lastSubmittedHeight = 100;

            // Gives allowance to burnRouter to burn tokens
            await CoreBTCSigner1.approve(
                burnRouter.address,
                userRequestedAmount
            );

            // Sets mock contracts outputs
            await setRelayLastSubmittedHeight(lastSubmittedHeight);
            await setLockersIsLocker(true);

            // Finds amount of coreBTC that user should receive on Bitcoin
            let protocolFee = Math.floor(userRequestedAmount * PROTOCOL_PERCENTAGE_FEE / 10000);
            let _burntAmount = userRequestedAmount - protocolFee;
            await setLockersBurnReturn(_burntAmount);

            let burntAmount = _burntAmount * (_burntAmount - BITCOIN_FEE) / _burntAmount;
            // first burntAmount should have been
            // burntAmount - lockerFee but in this case we have assumed lockerFee = 0

            ;
            await setLockersGetLockerTargetAddress();

            let prevBalanceSigner1 = await coreBTC.balanceOf(signer1Address);

            // Burns coreBTC

            await expect(
                await burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.emit(burnRouter, "CCBurn").withArgs(
                signer1Address,
                USER_SCRIPT_P2PKH,
                USER_SCRIPT_P2PKH_TYPE,
                userRequestedAmount,
                burntAmount,
                ONE_ADDRESS,
                0,
                lastSubmittedHeight + TRANSFER_DEADLINE
            );

            let newBalanceSigner1 = await coreBTC.balanceOf(signer1Address);

            // Checks user's balance
            expect(
                await newBalanceSigner1
            ).to.equal(prevBalanceSigner1.sub(userRequestedAmount));

            // Checks that protocol fee has been received
            expect(
                await coreBTC.balanceOf(TREASURY)
            ).to.equal(protocolFee);

            // Gets the burn request that has been saved in the contract
            let theBurnRequest = await burnRouter.burnRequests(LOCKER_TARGET_ADDRESS, 0);

            expect(
                theBurnRequest.burntAmount
            ).to.equal(burntAmount);

        })
        
        it("Successfully performs CCBurn when locker burntAmount is 0", async function () {
            let lastSubmittedHeight = 100;

            // Gives allowance to burnRouter to burn tokens
            await CoreBTCSigner1.approve(
                burnRouter.address,
                userRequestedAmount
            );
            // Sets mock contracts outputs
            await setRelayLastSubmittedHeight(lastSubmittedHeight);
            await setLockersIsLocker(true);
            await setLockersBurnReturn(0);
            await setLockersGetLockerTargetAddress();
            await expect(
                await burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.emit(burnRouter, "CCBurn").withArgs(
                signer1Address,
                USER_SCRIPT_P2PKH,
                USER_SCRIPT_P2PKH_TYPE,
                userRequestedAmount,
                0,
                ONE_ADDRESS,
                0,
                lastSubmittedHeight + TRANSFER_DEADLINE
            );
        })
        it("Reverts since requested amount doesn't cover Bitcoin fee", async function () {
            let lastSubmittedHeight = 100;

            // Gives allowance to burnRouter to burn tokens
            await CoreBTCSigner1.approve(
                burnRouter.address,
                BITCOIN_FEE - 1
            );

            // Sets mock contracts outputs
            await setRelayLastSubmittedHeight(lastSubmittedHeight);
            await setLockersIsLocker(true);
            ;
            await setLockersGetLockerTargetAddress();

            // Burns coreBTC
            await expect(
                burnRouterSigner1.ccBurn(
                    BITCOIN_FEE - 1,
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: low amount");

        })

        it("Reverts since allowance is not enough", async function () {

            // Sets mock contracts outputs
            await setLockersIsLocker(true);

            await setLockersGetLockerTargetAddress();

            // Gives allowance to burnRouter to burn tokens
            await CoreBTCSigner1.approve(
                burnRouter.address,
                0
            );

            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("ERC20: insufficient allowance")
        })

        it("Reverts since locker's locking script is not valid", async function () {

            await setLockersIsLocker(false);

            await expect(
                burnRouterSigner1.ccBurn(
                    userRequestedAmount,
                    USER_SCRIPT_P2PKH,
                    USER_SCRIPT_P2PKH_TYPE,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BurnRouter: not locker")
        })

    });
    describe("#burnProof", async () => {
        let burnReqBlockNumber = 100;

        let burntAmount: number;

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);

            // Mints CoreBTC for test
            await mintCoreBTCForTest();
            let init_requested_amount = 14000
            // Sends a burn request
            burntAmount = await sendBurnRequest(
                burnReqBlockNumber,
                init_requested_amount,
                USER_SCRIPT_P2PKH,
                USER_SCRIPT_P2PKH_TYPE
            );
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Submits a valid burn proof (for P2PKH)", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await expect(
                await burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [0],
                    [0]
                )
            ).to.emit(burnRouter, "PaidCCBurn").withArgs(
                LOCKER_TARGET_ADDRESS,
                0,
                CC_BURN_REQUESTS.burnProof_valid.txId,
                0
            );

            expect(
                await burnRouter.isUsedAsBurnProof(
                    CC_BURN_REQUESTS.burnProof_valid.txId
                )
            ).to.equal(true);
        })

        it("Submits a valid burn proof (for P2WPKH)", async function () {

            // Sends a burn request
            let ccBurnAmount = CC_BURN_REQUESTS.burnProof_validP2WPKH.ccBurnAmount;
            burntAmount = await sendBurnRequest(
                burnReqBlockNumber,
                ccBurnAmount,
                USER_SCRIPT_P2WPKH,
                USER_SCRIPT_P2WPKH_TYPE
            );

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_validP2WPKH.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_validP2WPKH.intermediateNodes,
                    0,
                    LOCKER1_LOCKING_SCRIPT,
                    [1], // Burn req index
                    [0]
                )
            ).to.emit(burnRouter, "PaidCCBurn").withArgs(
                LOCKER_TARGET_ADDRESS,
                1,
                CC_BURN_REQUESTS.burnProof_validP2WPKH.txId,
                0
            );

            expect(
                await burnRouter.isUsedAsBurnProof(
                    CC_BURN_REQUESTS.burnProof_validP2WPKH.txId
                )
            ).to.equal(true);
        })

        it("Submits a valid burn proof (for P2TR)", async function () {

            // Sends a burn request
            let ccBurnAmount = CC_BURN_REQUESTS.burnProof_validP2TR.ccBurnAmount;
            burntAmount = await sendBurnRequest(
                burnReqBlockNumber,
                ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_validP2TR.userScript,
                CC_BURN_REQUESTS.burnProof_validP2TR.userScriptType
            );

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_validP2TR.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_validP2TR.intermediateNodes,
                    0,
                    LOCKER1_LOCKING_SCRIPT,
                    [1], // Burn req index
                    [0]
                )
            ).to.emit(burnRouter, "PaidCCBurn").withArgs(
                LOCKER_TARGET_ADDRESS,
                1,
                CC_BURN_REQUESTS.burnProof_validP2TR.txId,
                0
            );

            expect(
                await burnRouter.isUsedAsBurnProof(
                    CC_BURN_REQUESTS.burnProof_validP2TR.txId
                )
            ).to.equal(true);
        })

        it("Submits a valid burn proof (for P2SH-P2WPKH)", async function () {

            // Sends a burn request
            let ccBurnAmount = CC_BURN_REQUESTS.burnProof_validP2SH_P2WPKH.ccBurnAmount;
            burntAmount = await sendBurnRequest(
                burnReqBlockNumber,
                ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_validP2SH_P2WPKH.userScript,
                CC_BURN_REQUESTS.burnProof_validP2SH_P2WPKH.userScriptType
            );

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_validP2SH_P2WPKH.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_validP2SH_P2WPKH.intermediateNodes,
                    0,
                    LOCKER1_LOCKING_SCRIPT,
                    [1], // Burn req index
                    [0]
                )
            ).to.emit(burnRouter, "PaidCCBurn").withArgs(
                LOCKER_TARGET_ADDRESS,
                1,
                CC_BURN_REQUESTS.burnProof_validP2SH_P2WPKH.txId,
                0
            );

            expect(
                await burnRouter.isUsedAsBurnProof(
                    CC_BURN_REQUESTS.burnProof_validP2SH_P2WPKH.txId
                )
            ).to.equal(true);
            expect(
                await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 1)
            ).to.equal(true);
        })

        it("Reverts since _burnReqIndexes is not sorted", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [0, 1],
                    [1, 0]
                )
            ).to.be.revertedWith("BurnRouter: un-sorted vout indexes")
        })

        it("Reverts since locktime is non-zero", async function () {
            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_invalid_locktime.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER_TARGET_ADDRESS,
                    [0],
                    [0]
                )
            ).to.revertedWith("BurnRouter: non-zero lock time")
        })

        it("Reverts if locking script is not valid", async function () {
            // Sets mock contracts outputs
            await setLockersIsLocker(false);

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER_TARGET_ADDRESS,
                    [0],
                    [0]
                )
            ).to.revertedWith("BurnRouter: not locker")
        })

        it("Reverts if given indexes doesn't match", async function () {

            // Set mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            // Should revert when start index is bigger than end index
            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER_TARGET_ADDRESS,
                    [0, 1],
                    [0]
                )
            ).to.revertedWith("BurnRouter: wrong indexes")

            // Should revert when end index is bigger than total number of burn requests
            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER_TARGET_ADDRESS,
                    [0],
                    [0, 1]
                )
            ).to.revertedWith("BurnRouter: wrong index")
        })

        it("Reverts if locker's tx has not been finalized on relay", async function () {
            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(false);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER_TARGET_ADDRESS,
                    [0],
                    [0]
                )
            ).to.revertedWith("BurnRouter: not finalized");
        })

        it("Reverts if vout is null", async function () {
            // Sends a burn request
            await sendBurnRequest(burnReqBlockNumber, 1111, USER_SCRIPT_P2PKH, USER_SCRIPT_P2PKH_TYPE);

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            // Should revert with a wrong start index
            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_vout_null.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_vout_null.intermediateNodes,
                    1,
                    LOCKER_TARGET_ADDRESS,
                    [0],
                    [0]
                )
            ).to.revertedWith("BitcoinHelper: invalid tx")
        })

        it("Doesn't accept burn proof since the paid amount is not exact", async function () {
            let wrongUserRequestAmount = 1000
            let burnReqBlockNumber = 100;

            // Send a burn request
            await sendBurnRequest(burnReqBlockNumber, wrongUserRequestAmount, USER_SCRIPT_P2PKH, USER_SCRIPT_P2PKH_TYPE);

            // Set mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            // Should revert with a wrong start index
            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER_TARGET_ADDRESS,
                    [1],
                    [1]
                )
            ).to.not.emit(burnRouter, "PaidCCBurn");

            expect(
                await burnRouterSigner2.isTransferred(LOCKER_TARGET_ADDRESS, 0)
            ).to.equal(false);
        })

        it("Doesn't accept burn proof since the proof has been submitted before", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await burnRouterSigner2.burnProof(
                CC_BURN_REQUESTS.burnProof_valid.tx,
                burnReqBlockNumber + 5,
                CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                1,
                LOCKER1_LOCKING_SCRIPT,
                [0],
                [0]
            );

            expect(
                await burnRouterSigner2.isTransferred(LOCKER_TARGET_ADDRESS, 0)
            ).to.equal(true);

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [0],
                    [0]
                )
            ).to.not.emit(burnRouter, "PaidCCBurn");
        })

        it("Doesn't accept burn proof since deadline is passed", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await expect(
                burnRouterSigner2.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    burnReqBlockNumber + TRANSFER_DEADLINE + 1,
                    CC_BURN_REQUESTS.burnProof_valid.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [0],
                    [0]
                )
            ).to.not.emit(burnRouter, "PaidCCBurn");

            expect(
                await burnRouterSigner2.isTransferred(LOCKER_TARGET_ADDRESS, 0)
            ).to.equal(false);
        })

        it("should reject vout with an invalid address", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();

            await burnRouterSigner2.burnProof(
                CC_BURN_REQUESTS.burnProof_invalid_vout.tx,
                burnReqBlockNumber + 5,
                CC_BURN_REQUESTS.burnProof_invalid_vout.intermediateNodes,
                1,
                LOCKER1_LOCKING_SCRIPT,
                [0],
                [0]
            );

            expect(
                await burnRouterSigner2.isTransferred(LOCKER_TARGET_ADDRESS, 0)
            ).to.equal(true);

            expect(
                await burnRouter.isUsedAsBurnProof(
                    CC_BURN_REQUESTS.burnProof_invalid_vout.txId
                )
            ).to.equal(false);

        })

        it("Submits valid burn proof with multiple vouts", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount1,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [1, 2],
                    [0, 1]
                )
            ).to.emit(burnRouterSigner2, 'PaidCCBurn')
            expect(
                await burnRouter.isUsedAsBurnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.txId
                )
            ).to.equal(true);
            expect(
                await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 1)
            ).to.equal(true);
            expect(
                await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 2)
            ).to.equal(true);

        })
        it("Successfully verifies one vout in burn proof with multiple outputs", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount1,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [2, 1],
                    [1, 2]
                )
            ).to.emit(burnRouterSigner2, 'PaidCCBurn')
            expect(
                await burnRouter.isUsedAsBurnProof(CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.txId)
            ).to.equal(false);
            expect(
                await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 1)
            ).to.equal(false);
            expect(
                await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 2)
            ).to.equal(true);
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [0, 2],
                    [0, 1]
                )
            ).to.not.emit(burnRouterSigner2, 'PaidCCBurn')
            expect(
                await burnRouter.isUsedAsBurnProof(CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.txId)
            ).to.equal(false);
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [1, 2],
                    [0, 1]
                )
            ).to.emit(burnRouterSigner2, 'PaidCCBurn')
            expect(await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 1)).to.equal(true);

            expect(
                await burnRouter.isUsedAsBurnProof(CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.txId)
            ).to.equal(true);
        })
        it("Successively verifies vout in a transaction with multiple payments", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount1,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [2],
                    [1]
                )
            ).to.emit(burnRouterSigner2, 'PaidCCBurn')
            expect(
                await burnRouter.isUsedAsBurnProof(CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.txId)
            ).to.equal(false);
            expect(
                await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 1)
            ).to.equal(false);
            expect(
                await burnRouter.isTransferred(LOCKER_TARGET_ADDRESS, 2)
            ).to.equal(true);
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [1],
                    [0]
                )
            ).to.emit(burnRouterSigner2, 'PaidCCBurn')
            expect(
                await burnRouter.isUsedAsBurnProof(CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.txId)
            ).to.equal(false);
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    burnReqBlockNumber + 5,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [1, 2],
                    [0, 1]
                )
            ).to.not.emit(burnRouterSigner2, 'PaidCCBurn')
            expect(
                await burnRouter.isUsedAsBurnProof(CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.txId)
            ).to.equal(true);

        })
        it("Reverts on expired ccburn request", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();
            await expect(
                burnRouter.burnProof(
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.tx,
                    0,
                    CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.intermediateNodes,
                    1,
                    LOCKER1_LOCKING_SCRIPT,
                    [0],
                    [0]
                )
            ).to.revertedWith('BurnRouter: old request')

        })
    });

    describe("#disputeBurn", async () => {
        let burnReqBlockNumber = 100;
        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
            // Mints CoreBTC for test
            await mintCoreBTCForTest();
            await burnRouter.setSlasher(deployerAddress);
            // Sends a burn request
            await sendBurnRequest(100, userRequestedAmount, USER_SCRIPT_P2PKH, USER_SCRIPT_P2PKH_TYPE);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Disputes locker successfully", async function () {
            // Sets mock contracts
            await setLockersSlashIdleLockerReturn();
            await setLockersIsLocker(true);
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await sendBurnRequest(
                burnReqBlockNumber,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount1,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 2);
            await expect(
                burnRouter.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [0]
                )
            ).to.emit(burnRouter, "BurnDispute");
            await expect(
                burnRouter.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [1, 2]
                )
            ).to.not.reverted;
        })

        it("Reverts since locker has been slashed before", async function () {
            // Sets mock contracts
            await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 1);
            await setLockersSlashIdleLockerReturn();
            await setLockersIsLocker(true);

            await burnRouter.disputeBurn(
                LOCKER_TARGET_ADDRESS,
                [0]
            );

            await expect(
                burnRouter.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [0]
                )
            ).to.revertedWith("BurnRouterLogic: already paid")
        })

        it("Reverts since locking script is invalid", async function () {

            // Sets mock contracts outputs
            await setLockersIsLocker(false);

            await expect(
                burnRouter.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [0]
                )
            ).to.revertedWith("BurnRouter: not locker")
        })

        it("Reverts since locker has paid before hand", async function () {

            // Sets mock contracts outputs
            await setLockersIsLocker(true);
            await setLockersSlashIdleLockerReturn();

            // Pays the burnt amount and provides proof
            await provideProof(burnReqBlockNumber + 5);

            await expect(
                burnRouter.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [0]
                )
            ).to.revertedWith("BurnRouterLogic: already paid")
        })

        it("Reverts since deadline hasn't reached", async function () {
            // Set mock contracts outputs
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(100);

            // Locker will not get slashed because the deadline of transfer has not reached
            await expect(
                burnRouter.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [0]
                )
            ).to.revertedWith("BurnRouterLogic: deadline not passed")
        })
        it("Reverts on expired ccburn request", async function () {
            // Set mock contracts outputs
            await sendBurnRequest(
                0,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(100);
            // Locker will not get slashed because the deadline of transfer has not reached
            await expect(
                burnRouter.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [1]
                )
            ).to.revertedWith("BurnRouterLogic: old request")
        })
        it("Reverts when non-slasher tries to disputeBurn", async function () {
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(100);
            await sendBurnRequest(
                0,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.ccBurnAmount,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScript,
                CC_BURN_REQUESTS.burnProof_valid_multiple_vouts.userScriptType
            );
            await expect(
                burnRouterSigner1.disputeBurn(
                    LOCKER_TARGET_ADDRESS,
                    [1]
                )
            ).to.revertedWith("BurnRouter: caller is not the slasher")
        })

    });

    describe("#disputeLocker", async () => {
        let burnReqBlockNumber = 100;
        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
            await burnRouter.transferOwnership(signer2Address);
            await burnRouterSigner2.acceptOwnership();
            await burnRouterSigner2.setSlasher(signer2Address);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Dispute the locker who has sent its BTC to external account", async function () {

            // Sets mock contracts outputs

            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 1);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashThiefLockerReturn();

            await expect(
                await burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.emit(burnRouter, "LockerDispute").withArgs(
                LOCKER_TARGET_ADDRESS,
                LOCKER1_LOCKING_SCRIPT,
                burnReqBlockNumber,
                CC_BURN_REQUESTS.disputeLocker_input.txId,
                CC_BURN_REQUESTS.disputeLocker_input.OutputValue +
                CC_BURN_REQUESTS.disputeLocker_input.OutputValue * SLASHER_PERCENTAGE_REWARD / 10000);
        })

        it("Reverts on invalid index and block height", async function () {
            await setLockersIsLocker(true);
            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1]
                )
            ).to.revertedWith("BurnRouterLogic: wrong inputs");
            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0]
                )
            ).to.revertedWith("BurnRouterLogic: wrong inputs");

            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    []
                )
            ).to.revertedWith("BurnRouterLogic: wrong inputs")

        })

        it("Reverts since locking script is not valid", async function () {

            // Sets mock contracts outputs
            await setLockersIsLocker(false);

            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.revertedWith("BurnRouter: not locker");
        })

        it("Reverts since input tx has not finalized", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(false);
            await setLockersIsLocker(true);

            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.revertedWith("BurnRouterLogic: not finalized");
        })

        it("Reverts due to input tx being already disputed by Dispute Locker", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 1);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashThiefLockerReturn();
            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.emit(burnRouterSigner2, "LockerDispute");
            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.revertedWith("BurnRouterLogic: already used");
        })

        it("Reverts since outpoint doesn't match with output tx", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 1);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashIdleLockerReturn();

            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_invalidOutput.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.revertedWith("BurnRouter: wrong output tx");
        })

        it("Reverts since tx doesn't belong to locker", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(burnReqBlockNumber + TRANSFER_DEADLINE + 1);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashIdleLockerReturn();

            await expect(
                burnRouterSigner2.disputeLocker(
                    "0x76a914748284390f9e263a4b766a75d0633c50426eb87587ab",
                    CC_BURN_REQUESTS.disputeLocker_input.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.revertedWith("BurnRouter: not for locker");
        })

        it("Reverts since locker may submit input tx as burn proof", async function () {

            // Sets mock contracts outputs
            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(burnReqBlockNumber);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashIdleLockerReturn();
            // User sends a burn request and locker provides burn proof for it
            await sendBurnRequest(burnReqBlockNumber, userRequestedAmount, USER_SCRIPT_P2PKH, USER_SCRIPT_P2PKH_TYPE);
            await provideProof(burnReqBlockNumber + 5);

            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.revertedWith("BurnRouterLogic: already used");
        })
        it("Reverts if the deadline is not yet passed", async function () {

            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashIdleLockerReturn();
            await sendBurnRequest(burnReqBlockNumber, userRequestedAmount, USER_SCRIPT_P2PKH, USER_SCRIPT_P2PKH_TYPE);
            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, burnReqBlockNumber]
                )
            ).to.revertedWith("BurnRouterLogic: deadline not passed");
        })
        it("Reverts on processing an old request", async function () {

            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(burnReqBlockNumber);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashIdleLockerReturn();
            await sendBurnRequest(burnReqBlockNumber, userRequestedAmount, USER_SCRIPT_P2PKH, USER_SCRIPT_P2PKH_TYPE);
            await expect(
                burnRouterSigner2.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, 0]
                )
            ).to.revertedWith("BurnRouterLogic: old request");
        })
        it("Reverts when non-slasher tries to disputeLocker", async function () {

            await setRelayCheckTxProofReturn(true);
            await setLockersIsLocker(true);
            await setRelayLastSubmittedHeight(burnReqBlockNumber);
            await setLockersGetLockerTargetAddress();
            await setLockersSlashIdleLockerReturn();
            await sendBurnRequest(burnReqBlockNumber, userRequestedAmount, USER_SCRIPT_P2PKH, USER_SCRIPT_P2PKH_TYPE);
            await expect(
                burnRouter.disputeLocker(
                    LOCKER1_LOCKING_SCRIPT,
                    CC_BURN_REQUESTS.burnProof_valid.tx,
                    CC_BURN_REQUESTS.disputeLocker_output.tx,
                    CC_BURN_REQUESTS.disputeLocker_input.intermediateNodes,
                    [0, 1, 0]
                )
            ).to.revertedWith("BurnRouter: caller is not the slasher");
        })
    });

    describe("#setters", async () => {

        beforeEach(async () => {
            snapshotId = await takeSnapshot(signer1.provider);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, snapshotId);
        });

        it("Sets protocol percentage fee", async function () {
            await expect(
                burnRouter.setProtocolPercentageFee(100)
            ).to.emit(
                burnRouter, "NewProtocolPercentageFee"
            ).withArgs(PROTOCOL_PERCENTAGE_FEE, 100);

            expect(
                await burnRouter.protocolPercentageFee()
            ).to.equal(100);
        })

        it("Reverts since protocol percentage fee is greater than 10000", async function () {
            await expect(
                burnRouter.setProtocolPercentageFee(10001)
            ).to.revertedWith("BurnRouter: invalid fee");
        })
        it("Sets starting block number", async function () {
            await burnRouter.setStartingBlockNumber(100);
            expect(
                await burnRouter.startingBlockNumber()
            ).to.equal(100);
            await expect(
                burnRouter.setStartingBlockNumber(99)
            ).to.revertedWith("BurnRouter: low startingBlockNumber");
        })


        it("Sets transfer deadline", async function () {

            await mockBitcoinRelay.mock.finalizationParameter.returns(10);
            await expect(
                burnRouter.setTransferDeadline(100)
            ).to.emit(
                burnRouter, "NewTransferDeadline"
            ).withArgs(TRANSFER_DEADLINE, 100);


            expect(
                await burnRouter.transferDeadline()
            ).to.equal(100);
        })

        it("Successfully changes transfer deadline without permit", async function () {
            await mockBitcoinRelay.mock.finalizationParameter.returns(10);
            await expect(
                burnRouter.setTransferDeadline(100)
            ).to.emit(burnRouter, "NewTransferDeadline");

            await mockBitcoinRelay.mock.finalizationParameter.returns(210);
            await expect(
                burnRouter.connect(signer2).setTransferDeadline(211)
            ).to.emit(burnRouter, "NewTransferDeadline");
        })

        it("Requires permit to change transfer deadline", async function () {
            await mockBitcoinRelay.mock.finalizationParameter.returns(10);
            await expect(burnRouter.connect(signer2).setTransferDeadline(100)).to.revertedWith('BurnRouter: no permit');
            await burnRouter.setTransferDeadline(100);
            await mockBitcoinRelay.mock.finalizationParameter.returns(101);
            await expect(
                burnRouter.connect(signer2).setTransferDeadline(102)
            ).to.emit(burnRouter, "NewTransferDeadline");
        })


        it("Reverts since transfer deadline is smaller than relay finalizatio parameter", async function () {
            await mockBitcoinRelay.mock.finalizationParameter.returns(10);

            await expect(
                burnRouter.setTransferDeadline(9)
            ).to.revertedWith("BurnRouter: low deadline");

        })

        it("Reverts since transfer deadline is smaller than relay finalizatio parameter", async function () {
            await mockBitcoinRelay.mock.finalizationParameter.returns(10);

            await expect(
                burnRouter.setTransferDeadline(10)
            ).to.revertedWith("BurnRouter: low deadline");

        })

        it("Sets slasher reward", async function () {
            await expect(
                burnRouter.setSlasherPercentageReward(100)
            ).to.emit(
                burnRouter, "NewSlasherPercentageFee"
            ).withArgs(SLASHER_PERCENTAGE_REWARD, 100);

            expect(
                await burnRouter.slasherPercentageReward()
            ).to.equal(100);
        })

        it("Reverts since slasher reward is greater than 100", async function () {
            await expect(
                burnRouter.setSlasherPercentageReward(10001)
            ).to.revertedWith("BurnRouter: invalid reward");
        })


        it("Sets BitcoinFeeOracle", async function () {
            await expect(
                burnRouter.setBitcoinFeeOracle(ONE_ADDRESS)
            ).to.emit(
                burnRouter, "NewBitcoinFeeOracle"
            ).withArgs(deployerAddress, ONE_ADDRESS);
        })


        it("Sets bitcoin fee", async function () {
            await expect(
                burnRouter.setBitcoinFee(100)
            ).to.emit(
                burnRouter, "NewBitcoinFee"
            ).withArgs(BITCOIN_FEE, 100);


            expect(
                await burnRouter.bitcoinFee()
            ).to.equal(100);
        })

        it("Sets relay, lockers, coreBTC，Slasher and treasury", async function () {
            await expect(
                burnRouter.setRelay(ONE_ADDRESS)
            ).to.emit(
                burnRouter, "NewRelay"
            ).withArgs(mockBitcoinRelay.address, ONE_ADDRESS);

            expect(
                await burnRouter.relay()
            ).to.equal(ONE_ADDRESS);

            await expect(
                burnRouter.setLockers(ONE_ADDRESS)
            ).to.emit(
                burnRouter, "NewLockers"
            ).withArgs(mockLockers.address, ONE_ADDRESS);

            expect(
                await burnRouter.lockers()
            ).to.equal(ONE_ADDRESS);

            await expect(
                burnRouter.setCoreBTC(ONE_ADDRESS)
            ).to.emit(
                burnRouter, "NewCoreBTC"
            ).withArgs(coreBTC.address, ONE_ADDRESS);

            expect(
                await burnRouter.coreBTC()
            ).to.equal(ONE_ADDRESS);

            await expect(
                burnRouter.setTreasury(ONE_ADDRESS)
            ).to.emit(
                burnRouter, "NewTreasury"
            ).withArgs(TREASURY, ONE_ADDRESS);
            expect(
                await burnRouter.treasury()
            ).to.equal(ONE_ADDRESS);
            await expect(
                burnRouter.setSlasher(ONE_ADDRESS)
            ).to.emit(burnRouter, 'NewSlasher')
                .withArgs(ZERO_ADDRESS, ONE_ADDRESS);
            expect(
                await burnRouter.slasher()
            ).to.equal(ONE_ADDRESS);

        })

        it("Reverts since given address is zero", async function () {
            await expect(
                burnRouter.setRelay(ZERO_ADDRESS)
            ).to.revertedWith("BurnRouter: zero address");

            await expect(
                burnRouter.setLockers(ZERO_ADDRESS)
            ).to.revertedWith("BurnRouter: zero address");

            await expect(
                burnRouter.setCoreBTC(ZERO_ADDRESS)
            ).to.revertedWith("BurnRouter: zero address");

            await expect(
                burnRouter.setTreasury(ZERO_ADDRESS)
            ).to.revertedWith("BurnRouter: zero address");
        })

        it("Reverts when non-owner attempts to call the function", async function () {
            await expect(
                burnRouterSigner2.setRelay(ONE_ADDRESS)
            ).to.revertedWith("Ownable: caller is not the owner");

            await expect(
                burnRouterSigner2.setLockers(ONE_ADDRESS)
            ).to.revertedWith("Ownable: caller is not the owner");

            await expect(
                burnRouterSigner2.setCoreBTC(ONE_ADDRESS)
            ).to.revertedWith("Ownable: caller is not the owner");

            await expect(
                burnRouterSigner2.setTreasury(ONE_ADDRESS)
            ).to.revertedWith("Ownable: caller is not the owner");
            await expect(
                burnRouterSigner2.setSlasher(ONE_ADDRESS)
            ).to.revertedWith("Ownable: caller is not the owner");
        })

    });

    describe("#renounce ownership", async () => {
        it("owner can't renounce ownership", async function () {
            await burnRouter.renounceOwnership()
            await expect(
                await burnRouter.owner()
            ).to.equal(deployerAddress);
        })
    });
});