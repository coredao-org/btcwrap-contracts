const CC_REQUESTS = require('./test_fixtures/ccTransferRequests.json');
require('dotenv').config({path: "../../.env"});

import {expect} from "chai";
import {deployments, ethers} from "hardhat";
import {Signer, BigNumber} from "ethers";
import {deployMockContract, MockContract} from "@ethereum-waffle/mock-contract";
import {Contract} from "@ethersproject/contracts";
import {Address} from "hardhat-deploy/types";

import {CcTransferRouterProxy__factory} from "../src/types/factories/CcTransferRouterProxy__factory";
import {CcTransferRouterLogic__factory} from "../src/types/factories/CcTransferRouterLogic__factory";

import {LockersProxy__factory} from "../src/types/factories/LockersProxy__factory";
import {LockersLogic__factory} from "../src/types/factories/LockersLogic__factory";
import {LockersLogicLibraryAddresses} from "../src/types/factories/LockersLogic__factory";

import {LockersLib} from "../src/types/LockersLib";
import {LockersLib__factory} from "../src/types/factories/LockersLib__factory";

import {CoreBTCLogic} from "../src/types/CoreBTCLogic";
import {CoreBTCLogic__factory} from "../src/types/factories/CoreBTCLogic__factory";
import {CoreBTCProxy__factory} from "../src/types/factories/CoreBTCProxy__factory";

import {takeSnapshot, revertProvider} from "./block_utils";

describe("CcTransferRouter", async () => {

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000001";
    let TWO_ADDRESS = "0x0000000000000000000000000000000000000002";
    const VERSION = 1
    const CHAIN_ID = 1115;
    const APP_ID = 1;
    const PROTOCOL_PERCENTAGE_FEE = 5; // Means %0.1
    const LOCKER_PERCENTAGE_FEE = 15; // Means %0.2
    const PRICE_WITH_DISCOUNT_RATIO = 9000; // Means %95
    const STARTING_BLOCK_NUMBER = 1;
    const TREASURY = "0x0000000000000000000000000000000000000002";

    let LOCKER1_LOCKING_SCRIPT = '0x76a914e1c5ba4d1fef0a3c7806603de565929684f9c2b188ac';
    let LOCKER2_LOCKING_SCRIPT = '0x76a914e1c5ba4d1fef0a3c7806603de565929684f9c2b188a1';

    let LOCKER_RESCUE_SCRIPT_P2PKH = "0x12ab8dc588ca9d5787dde7eb29569da63c3a238c";
    let LOCKER_RESCUE_SCRIPT_P2PKH_TYPE = 1; // P2PKH

    let minRequiredTNTLockedAmount = BigNumber.from(10).pow(18).mul(5);
    let collateralRatio = 20000;
    let liquidationRatio = 15000;

    // Accounts
    let proxyAdmin: Signer;
    let deployer: Signer;
    let signer1: Signer;
    let locker: Signer;
    let locker1: Signer;
    let lockerAddress: Address;
    let locker1Address: Address;
    let deployerAddress: Address;
    let signer1Address: Address;

    // Contracts
    let ccTransferRouter: Contract;
    let coreBTC: CoreBTCLogic;
    let lockersLib: LockersLib;
    let lockers: Contract;

    // Mock contracts
    let mockBitcoinRelay: MockContract;
    // let mockBitcoinHelper: MockContract;
    let mockPriceOracle: MockContract;

    let beginning: any;

    before(async () => {
        // Sets accounts
        [proxyAdmin, deployer, signer1, locker, locker1] = await ethers.getSigners();

        lockerAddress = await locker.getAddress();
        locker1Address = await locker1.getAddress();
        deployerAddress = await deployer.getAddress();
        signer1Address = await signer1.getAddress();

        // Mocks relay contract
        const bitcoinRelayContract = await deployments.getArtifact(
            "IBitcoinRelay"
        );
        mockBitcoinRelay = await deployMockContract(
            deployer,
            bitcoinRelayContract.abi
        );

        // Mocks price oracle contract
        const priceOracleContract = await deployments.getArtifact(
            "IPriceOracle"
        );
        mockPriceOracle = await deployMockContract(
            deployer,
            priceOracleContract.abi
        );
        // Sets equivalentOutputAmount to return 100000
        await mockPriceOracle.mock.equivalentOutputAmount.returns(10000000)

        // Deploys ccTransferRouter contract
        const ccTransferRouterLogicFactory = new CcTransferRouterLogic__factory(deployer);
        const ccTransferRouterLogic = await ccTransferRouterLogicFactory.deploy();

        const ccTransferRouterProxyFactory = new CcTransferRouterProxy__factory(deployer);
        const ccTransferRouterProxy = await ccTransferRouterProxyFactory.deploy(
            ccTransferRouterLogic.address,
            "0x"
        );

        ccTransferRouter = await ccTransferRouterLogic.attach(
            ccTransferRouterProxy.address
        );

        await ccTransferRouter.initialize(
            STARTING_BLOCK_NUMBER,
            PROTOCOL_PERCENTAGE_FEE,
            VERSION,
            CHAIN_ID,
            APP_ID,
            mockBitcoinRelay.address,
            ONE_ADDRESS,
            TWO_ADDRESS,
            TREASURY
        );
        coreBTC = await deployCoreBTC();
        // Set coreBTC address in ccTransferRouter
        await ccTransferRouter.setCoreBTC(coreBTC.address);

        // Deploys lockers contract
        lockers = await deployLockers();
        await lockers.setCoreBTC(coreBTC.address)
        await lockers.addMinter(ccTransferRouter.address)

        // Adds lockers contract as minter and burner in coreBTC
        await coreBTC.addMinter(lockers.address)
        await coreBTC.addBurner(lockers.address)

        await ccTransferRouter.setLockers(lockers.address)
    });
    const deployCoreBTC = async (
        _signer?: Signer
    ): Promise<CoreBTCLogic> => {
        const coreBTCLogicFactory = new CoreBTCLogic__factory(deployer);
        const coreBTCLogicImpl = await coreBTCLogicFactory.deploy();
        const methodSig = ethers.utils.id(
            "initialize(string,string)"
        );
        const tokenName = "coreBTC";
        const tokenSymbol = "CBTC";
        const params = ethers.utils.defaultAbiCoder.encode(
            ['string', 'string'],
            [tokenName, tokenSymbol]
        );
        const initCode = ethers.utils.solidityPack(
            ['bytes', 'bytes'],
            [methodSig.slice(0, 10), params]
        );
        const coreBTCProxyFactory = new CoreBTCProxy__factory(deployer);
        const coreBTCProxy = await coreBTCProxyFactory.deploy(
            coreBTCLogicImpl.address,
            initCode
        );
        coreBTC = await coreBTCLogicFactory.attach(
            coreBTCProxy.address
        )
        return coreBTC;
    };

    const deployLockersLib = async (
        _signer?: Signer
    ): Promise<LockersLib> => {
        const LockersLibFactory = new LockersLib__factory(
            _signer || deployer
        );

        const lockersLib = await LockersLibFactory.deploy(
        );

        return lockersLib;
    };

    const deployLockers = async (
        _signer?: Signer
    ): Promise<Contract> => {

        lockersLib = await deployLockersLib()

        let linkLibraryAddresses: LockersLogicLibraryAddresses;

        linkLibraryAddresses = {
            "contracts/libraries/LockersLib.sol:LockersLib": lockersLib.address,
        };

        // Deploys lockers logic
        const lockersLogicFactory = new LockersLogic__factory(
            linkLibraryAddresses,
            _signer || deployer
        );

        const lockersLogic = await lockersLogicFactory.deploy();

        // Deploys lockers proxy
        const lockersProxyFactory = new LockersProxy__factory(
            _signer || deployer
        );
        const lockersProxy = await lockersProxyFactory.deploy(
            lockersLogic.address,
            "0x"
        )

        const lockers = await lockersLogic.attach(
            lockersProxy.address
        );

        // Initializes lockers proxy
        await lockers.initialize(
            coreBTC.address,
            mockPriceOracle.address,
            minRequiredTNTLockedAmount,
            collateralRatio,
            liquidationRatio,
            LOCKER_PERCENTAGE_FEE,
            PRICE_WITH_DISCOUNT_RATIO
        )

        return lockers;
    };

    async function setRelayReturn(isTrue: boolean): Promise<void> {
        await mockBitcoinRelay.mock.checkTxProof.returns(isTrue); // Sets result of checking tx proof
    }

    async function addLockerToLockers(): Promise<void> {
        let lockerLocker = lockers.connect(locker);
        await lockerLocker.requestToBecomeLocker(
            // LOCKER1, // Public key of locker
            LOCKER1_LOCKING_SCRIPT, // Public key hash of locker
            minRequiredTNTLockedAmount,
            LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
            LOCKER_RESCUE_SCRIPT_P2PKH,
            {value: minRequiredTNTLockedAmount}
        )
        // Deployer (owner of lockers) adds locker to lockers
        await lockers.addLocker(lockerAddress);

    }

    async function checkFees(
        recipientAddress: string,
        receivedAmount: number,
        porterFee: number,
        protocolFee: number,
        lockerFee: number,
        prevSupply: number,
        bitcoinAmount: number
    ): Promise<void> {
        // Checks that enough coreBTC has been minted for user
        expect(
            await coreBTC.balanceOf(recipientAddress)
        ).to.equal(receivedAmount);

        // Checks that enough coreBTC has been minted for porter
        expect(
            await coreBTC.balanceOf(await deployer.getAddress())
        ).to.equal(porterFee);

        // Checks that correct amount of coreBTC has been minted for protocol
        expect(
            await coreBTC.balanceOf(TREASURY)
        ).to.equal(protocolFee);

        // Checks that correct amount of coreBTC has been minted for locker
        expect(
            await coreBTC.balanceOf(lockerAddress)
        ).to.equal(lockerFee);

        // Checks that correct amount of coreBTC has been minted in total
        expect(
            await coreBTC.totalSupply()
        ).to.equal(prevSupply + bitcoinAmount);
    }

    describe("#initialize", async () => {
        it("initialize can be called only once", async function () {
            await expect(
                ccTransferRouter.initialize(
                    STARTING_BLOCK_NUMBER,
                    PROTOCOL_PERCENTAGE_FEE,
                    VERSION,
                    CHAIN_ID,
                    APP_ID,
                    mockBitcoinRelay.address,
                    ONE_ADDRESS,
                    TWO_ADDRESS,
                    TREASURY
                )).to.be.revertedWith("Initializable: contract is already initialized")
        })
    });

    describe("#lockProof", async () => {

        beforeEach(async () => {
            beginning = await takeSnapshot(signer1.provider);
            await addLockerToLockers();
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, beginning);
        });

        it("Mints coreBTC for normal cc lockProof request", async function () {
            let prevSupply = await coreBTC.totalSupply();
            // Mocks relay to return true after checking tx proof
            await setRelayReturn(true);

            // Calculates fees
            let lockerFee = Math.floor(
                CC_REQUESTS.normalCCTransfer.bitcoinAmount * LOCKER_PERCENTAGE_FEE / 10000
            );
            let porterFee = Math.floor(
                CC_REQUESTS.normalCCTransfer.bitcoinAmount * CC_REQUESTS.normalCCTransfer.porterPercentageFee / 10000);
            let protocolFee = Math.floor(
                CC_REQUESTS.normalCCTransfer.bitcoinAmount * PROTOCOL_PERCENTAGE_FEE / 10000
            );

            // Calculates amount that user should have received
            let receivedAmount = CC_REQUESTS.normalCCTransfer.bitcoinAmount - lockerFee - porterFee - protocolFee;

            // Checks that ccTransfer is executed successfully
            await expect(
                await ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx,
                    CC_REQUESTS.normalCCTransfer.blockNumber,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER1_LOCKING_SCRIPT,
                )
            ).to.emit(ccTransferRouter, "CCTransfer").withArgs(
                LOCKER1_LOCKING_SCRIPT,
                0,
                lockerAddress,
                CC_REQUESTS.normalCCTransfer.recipientAddress,
                CC_REQUESTS.normalCCTransfer.bitcoinAmount,
                receivedAmount,
                deployerAddress,
                porterFee,
                protocolFee,
                CC_REQUESTS.normalCCTransfer.txId
            );

            await checkFees(
                CC_REQUESTS.normalCCTransfer.recipientAddress,
                receivedAmount,
                porterFee,
                protocolFee,
                lockerFee,
                prevSupply.toNumber(),
                CC_REQUESTS.normalCCTransfer.bitcoinAmount
            );
        })
        it("Mints coreBTC for normal cc transfer request (zero porter fee)", async function () {
            let prevSupply = await coreBTC.totalSupply();
            // Mocks relay to return true after checking tx proof
            await setRelayReturn(true);

            // Calculates fees
            let lockerFee = Math.floor(
                CC_REQUESTS.normalCCTransfer_zeroFee.bitcoinAmount * LOCKER_PERCENTAGE_FEE / 10000
            );
            let porterFee = Math.floor(
                CC_REQUESTS.normalCCTransfer_zeroFee.bitcoinAmount * CC_REQUESTS.normalCCTransfer_zeroFee.porterPercentageFee / 10000
            );
            let protocolFee = Math.floor(
                CC_REQUESTS.normalCCTransfer_zeroFee.bitcoinAmount * PROTOCOL_PERCENTAGE_FEE / 10000
            );

            // Calculates amount that user should have received
            let receivedAmount = CC_REQUESTS.normalCCTransfer_zeroFee.bitcoinAmount - lockerFee - porterFee - protocolFee;

            // Checks that ccTransfer is executed successfully
            await expect(
                await ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer_zeroFee.tx,
                    CC_REQUESTS.normalCCTransfer_zeroFee.blockNumber,
                    CC_REQUESTS.normalCCTransfer_zeroFee.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer_zeroFee.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.emit(ccTransferRouter, 'CCTransfer').withArgs(
                LOCKER1_LOCKING_SCRIPT,
                0,
                lockerAddress,
                CC_REQUESTS.normalCCTransfer_zeroFee.recipientAddress,
                CC_REQUESTS.normalCCTransfer_zeroFee.bitcoinAmount,
                receivedAmount,
                deployerAddress,
                porterFee,
                protocolFee,
                CC_REQUESTS.normalCCTransfer_zeroFee.txId
            );

            await checkFees(
                CC_REQUESTS.normalCCTransfer_zeroFee.recipientAddress,
                receivedAmount,
                porterFee,
                protocolFee,
                lockerFee,
                prevSupply.toNumber(),
                CC_REQUESTS.normalCCTransfer_zeroFee.bitcoinAmount
            );
        })

        it("Mints coreBTC for normal cc transfer request (zero protocol fee)", async function () {
            let prevSupply = await coreBTC.totalSupply();

            // Sets protocol fee
            await ccTransferRouter.setProtocolPercentageFee(0);

            // Mocks relay to return true after checking tx proof
            await setRelayReturn(true);

            // Calculates fees
            let lockerFee = Math.floor(
                CC_REQUESTS.normalCCTransfer.bitcoinAmount * LOCKER_PERCENTAGE_FEE / 10000
            );
            let porterFee = Math.floor(
                CC_REQUESTS.normalCCTransfer.bitcoinAmount * CC_REQUESTS.normalCCTransfer.porterPercentageFee / 10000
            );
            let protocolFee = 0;

            // Calculates amount that user should have received
            let receivedAmount = CC_REQUESTS.normalCCTransfer.bitcoinAmount - lockerFee - porterFee - protocolFee;

            // Checks that ccTransfer is executed successfully
            await expect(
                await ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx,
                    CC_REQUESTS.normalCCTransfer.blockNumber,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER1_LOCKING_SCRIPT,
                )
            ).to.emit(ccTransferRouter, 'CCTransfer').withArgs(
                LOCKER1_LOCKING_SCRIPT,
                0,
                lockerAddress,
                CC_REQUESTS.normalCCTransfer.recipientAddress,
                CC_REQUESTS.normalCCTransfer.bitcoinAmount,
                receivedAmount,
                deployerAddress,
                porterFee,
                protocolFee,
                CC_REQUESTS.normalCCTransfer.txId
            );

            await checkFees(
                CC_REQUESTS.normalCCTransfer.recipientAddress,
                receivedAmount,
                porterFee,
                protocolFee,
                lockerFee,
                prevSupply.toNumber(),
                CC_REQUESTS.normalCCTransfer.bitcoinAmount
            );
        })

        it("Reverts since request belongs to an old block header", async function () {
            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx,
                    STARTING_BLOCK_NUMBER - 1,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: request is too old");
        })

        it("Reverts if the request has been used before", async function () {
            await setRelayReturn(true);

            await ccTransferRouter.lockProof(
                CC_REQUESTS.normalCCTransfer.tx,
                CC_REQUESTS.normalCCTransfer.blockNumber,
                CC_REQUESTS.normalCCTransfer.intermediateNodes,
                CC_REQUESTS.normalCCTransfer.index,
                LOCKER1_LOCKING_SCRIPT,
            );

            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx,
                    CC_REQUESTS.normalCCTransfer.blockNumber,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: request has been used before");
        })

        it("Reverts if the request has not been finalized on the relay", async function () {

            // Sets relay to return false after checking tx proof
            await setRelayReturn(false);

            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx,
                    CC_REQUESTS.normalCCTransfer.blockNumber,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: transaction has not been finalized yet");
        })

        it("Reverts if the percentage fee is out of range [0,10000)", async function () {
            await setRelayReturn(true);
            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer_invalidFee.tx,
                    CC_REQUESTS.normalCCTransfer_invalidFee.blockNumber,
                    CC_REQUESTS.normalCCTransfer_invalidFee.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer_invalidFee.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: percentage fee is out of range");
        })

        it("Reverts if chain id is invalid", async function () {
            await setRelayReturn(true);

            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer_invalidChainId.tx,
                    CC_REQUESTS.normalCCTransfer_invalidChainId.blockNumber,
                    CC_REQUESTS.normalCCTransfer_invalidChainId.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer_invalidChainId.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: chain id is not correct");
        })

        it("Reverts if app id is invalid", async function () {
            await setRelayReturn(true);

            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer_invalidAppId.tx,
                    CC_REQUESTS.normalCCTransfer_invalidAppId.blockNumber,
                    CC_REQUESTS.normalCCTransfer_invalidAppId.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer_invalidAppId.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: app id is not correct");
        })

        it("Reverts if user sent BTC to invalid locker", async function () {
            await setRelayReturn(true);

            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer_invalidLocker.tx,
                    CC_REQUESTS.normalCCTransfer_invalidLocker.blockNumber,
                    CC_REQUESTS.normalCCTransfer_invalidLocker.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer_invalidLocker.index,
                    CC_REQUESTS.normalCCTransfer_invalidLocker.lockerAddress
                )
            ).to.revertedWith("CCTransferRouter: no locker with the given locking script exists");
        })

        it("Reverts if no BTC has been sent to locker", async function () {
            await setRelayReturn(true);
            let lockerLocker1 = lockers.connect(locker1)
            await lockerLocker1.requestToBecomeLocker(
                // LOCKER1, // Public key of locker
                LOCKER2_LOCKING_SCRIPT, // Public key hash of locker
                minRequiredTNTLockedAmount,
                LOCKER_RESCUE_SCRIPT_P2PKH_TYPE,
                LOCKER_RESCUE_SCRIPT_P2PKH,
                {value: minRequiredTNTLockedAmount}
            )
            // Deployer (owner of lockers) adds locker to lockers
            await lockers.addLocker(locker1Address)
            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx,
                    CC_REQUESTS.normalCCTransfer.blockNumber,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER2_LOCKING_SCRIPT,
                )
            ).to.revertedWith("CCTransferRouter: input amount is zero");
        })
        it("Reverts when transaction lock time is non-zero", async function () {
            await setRelayReturn(true);
            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx.slice(0, -1) + '1',
                    CC_REQUESTS.normalCCTransfer.blockNumber,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: lock time is non -zero");
        })
        it("Reverts transaction with invalid OP_RETURN", async function () {
            await setRelayReturn(true);
            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer_invalid_OP_RETURN.tx,
                    CC_REQUESTS.normalCCTransfer_invalid_OP_RETURN.blockNumber,
                    CC_REQUESTS.normalCCTransfer_invalid_OP_RETURN.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer_invalid_OP_RETURN.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("BitcoinHelper: invalid tx");
        })
        it("Reverts if version is invalid", async function () {
            await setRelayReturn(true);
            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer_invalidVersion.tx,
                    CC_REQUESTS.normalCCTransfer_invalidVersion.blockNumber,
                    CC_REQUESTS.normalCCTransfer_invalidVersion.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer_invalidVersion.index,
                    LOCKER1_LOCKING_SCRIPT
                )
            ).to.revertedWith("CCTransferRouter: version is not correct");
        })
        it("Mints CoreBTC successfully", async function () {
            await setRelayReturn(true);
            let inputAmount = 1000000
            await expect(
                await ccTransferRouter.lockProof(
                    CC_REQUESTS.normalLockProof.tx,
                    CC_REQUESTS.normalLockProof.blockNumber,
                    CC_REQUESTS.normalLockProof.intermediateNodes,
                    CC_REQUESTS.normalLockProof.index,
                    LOCKER1_LOCKING_SCRIPT,
                )
            ).to.emit(ccTransferRouter, 'CCTransfer')
            let prevSupply = await coreBTC.totalSupply();
            expect(prevSupply).to.equal(inputAmount);
            // collect transaction fee
            let feeRate = PROTOCOL_PERCENTAGE_FEE + LOCKER_PERCENTAGE_FEE + 20
            const fee = inputAmount * feeRate / 10000
            let prevSupply1 = await coreBTC.balanceOf(signer1Address);
            inputAmount -= fee
            expect(prevSupply1).to.equal(inputAmount);
        })
    });

    describe("#isRequestUsed", async () => {

        beforeEach(async () => {
            beginning = await takeSnapshot(signer1.provider);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, beginning);
        });

        it("Checks if the request has been used before (unused)", async function () {
            expect(
                await ccTransferRouter.isRequestUsed(CC_REQUESTS.normalCCTransfer.txId)
            ).to.equal(false);
        })

        it("Reverts since the request has been executed before", async function () {
            await setRelayReturn(true);
            await addLockerToLockers();
            await ccTransferRouter.lockProof(
                CC_REQUESTS.normalCCTransfer.tx,
                CC_REQUESTS.normalCCTransfer.blockNumber,
                CC_REQUESTS.normalCCTransfer.intermediateNodes,
                CC_REQUESTS.normalCCTransfer.index,
                LOCKER1_LOCKING_SCRIPT,
            );

            expect(
                await ccTransferRouter.isRequestUsed(CC_REQUESTS.normalCCTransfer.txId)
            ).to.equal(true);

            await expect(
                ccTransferRouter.lockProof(
                    CC_REQUESTS.normalCCTransfer.tx,
                    CC_REQUESTS.normalCCTransfer.blockNumber,
                    CC_REQUESTS.normalCCTransfer.intermediateNodes,
                    CC_REQUESTS.normalCCTransfer.index,
                    LOCKER1_LOCKING_SCRIPT,
                )
            ).to.revertedWith("CCTransferRouter: request has been used before");
        })

    });

    describe("#setters", async () => {

        beforeEach(async () => {
            beginning = await takeSnapshot(signer1.provider);
        });

        afterEach(async () => {
            await revertProvider(signer1.provider, beginning);
        });

        it("Sets protocol percentage fee", async function () {
            await expect(
                ccTransferRouter.setProtocolPercentageFee(100)
            ).to.emit(
                ccTransferRouter, "NewProtocolPercentageFee"
            ).withArgs(PROTOCOL_PERCENTAGE_FEE, 100);

            expect(
                await ccTransferRouter.protocolPercentageFee()
            ).to.equal(100);
        })
        
        it("Sets Starting BlockNumber", async function () {
            await ccTransferRouter.setStartingBlockNumber(100)
            expect(
                await ccTransferRouter.startingBlockNumber()
            ).to.equal(100);
            await expect( ccTransferRouter.setStartingBlockNumber(99)).to.revertedWith(
                "CCTransferRouter: low startingBlockNumber"
            )
        })
        it("Reverts since protocol percentage fee is greater than 10000", async function () {
            await expect(
                ccTransferRouter.setProtocolPercentageFee(10001)
            ).to.revertedWith("CCTransferRouter: protocol fee is out of range");
            await expect(
                ccTransferRouter.setProtocolPercentageFee(20000)
            ).to.be.revertedWith("CCTransferRouter: protocol fee is out of range");
        })

        it("Sets relay, lockers, instant router, coreBTC and treasury", async function () {
            await expect(
                await ccTransferRouter.setRelay(ONE_ADDRESS)
            ).to.emit(
                ccTransferRouter, "NewRelay"
            ).withArgs(mockBitcoinRelay.address, ONE_ADDRESS);


            expect(
                await ccTransferRouter.relay()
            ).to.equal(ONE_ADDRESS);

            await expect(
                await ccTransferRouter.setLockers(ONE_ADDRESS)
            ).to.emit(
                ccTransferRouter, "NewLockers"
            ).withArgs(lockers.address, ONE_ADDRESS);

            expect(
                await ccTransferRouter.lockers()
            ).to.equal(ONE_ADDRESS);

            await expect(
                ccTransferRouter.connect(signer1).setLockers(ONE_ADDRESS)
            ).to.be.revertedWith("Ownable: caller is not the owner")

            await expect(
                await ccTransferRouter.setCoreBTC(ONE_ADDRESS)
            ).to.emit(
                ccTransferRouter, "NewCoreBTC"
            ).withArgs(coreBTC.address, ONE_ADDRESS);

            expect(
                await ccTransferRouter.coreBTC()
            ).to.equal(ONE_ADDRESS);

            await expect(
                ccTransferRouter.connect(signer1).setCoreBTC(ONE_ADDRESS)
            ).to.be.revertedWith("Ownable: caller is not the owner")

            await expect(
                await ccTransferRouter.setTreasury(ONE_ADDRESS)
            ).to.emit(
                ccTransferRouter, "NewTreasury"
            ).withArgs(TREASURY, ONE_ADDRESS);


            expect(
                await ccTransferRouter.treasury()
            ).to.equal(ONE_ADDRESS);

            await expect(
                ccTransferRouter.connect(signer1).setTreasury(ONE_ADDRESS)
            ).to.be.revertedWith("Ownable: caller is not the owner")

            await expect(
                ccTransferRouter.connect(signer1).renounceOwnership()
            ).to.be.revertedWith("Ownable: caller is not the owner")

            await ccTransferRouter.renounceOwnership()

        })

        it("Reverts since given address is zero", async function () {
            await expect(
                ccTransferRouter.setRelay(ZERO_ADDRESS)
            ).to.revertedWith("CCTransferRouter: address is zero");

            await expect(
                ccTransferRouter.setLockers(ZERO_ADDRESS)
            ).to.revertedWith("CCTransferRouter: address is zero");
            await expect(
                ccTransferRouter.setCoreBTC(ZERO_ADDRESS)
            ).to.revertedWith("CCTransferRouter: address is zero");

            await expect(
                ccTransferRouter.setTreasury(ZERO_ADDRESS)
            ).to.revertedWith("CCTransferRouter: address is zero");
        })
    })
});