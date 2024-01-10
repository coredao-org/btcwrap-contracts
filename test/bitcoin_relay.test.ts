import {revertProvider, takeSnapshot} from "./block_utils";

require('dotenv').config({path: "../../.env"});
import {expect} from "chai";
import {deployments, ethers} from "hardhat";
import {Signer, BigNumber} from "ethers";
import {deployMockContract, MockContract} from "@ethereum-waffle/mock-contract";
import {Contract} from "@ethersproject/contracts";
import {BitcoinRelayLogic__factory} from "../src/types/factories/BitcoinRelayLogic__factory";
import {BitcoinRelayProxy__factory} from "../src/types/factories/BitcoinRelayProxy__factory";
import {Address} from "hardhat-deploy/types";

describe("Bitcoin Relay", async () => {

    // Constants
    let ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    let ONE_ADDRESS = "0x0000000000000000000000000000000000000001";
    let initialHeight = 100;
    let txId = "0x893318aa3a2732f43fcf4780ba32cec65fed764cfa5bafb6ebd5fab684a4aa5c"
    let finalizationParameter = 3
    let chainTipHeight = 150
    let MAX_FINALIZATION_PARAMETER = 432


    // Accounts
    let deployer: Signer;
    let signer1: Signer;
    let signer2: Signer;
    let deployerAddress: Address;
    // Contracts
    let BitcoinRelay: Contract;
    // Mock contracts
    let mockBtcLightClient: MockContract;

    let beginning: any;


    before(async () => {
        [deployer, signer1, signer2] = await ethers.getSigners();
        deployerAddress = await deployer.getAddress();
        const bitcoinRelayFactory = new BitcoinRelayLogic__factory(deployer);
        const RelayLogic = await bitcoinRelayFactory.deploy();
        const bitcoinRelayProxyFactory = new BitcoinRelayProxy__factory(deployer);
        const RelayProxy = await bitcoinRelayProxyFactory.deploy(
            RelayLogic.address,
            "0x"
        );
        BitcoinRelay = await RelayLogic.attach(
            RelayProxy.address
        )


        const BtcLightClientContract = await deployments.getArtifact(
            "MockIBtcLightClient"
        );
        mockBtcLightClient = await deployMockContract(deployer, BtcLightClientContract.abi);
        BitcoinRelay.initialize(
            100,
            mockBtcLightClient.address,
            finalizationParameter
        )
    });
    describe("#initialize", async () => {
        it("initialize can be called only once", async function () {
            await expect(
                BitcoinRelay.initialize(
                    1,
                    ONE_ADDRESS,
                    finalizationParameter
                )
            ).to.be.revertedWith("Initializable: contract is already initialized")
        })
    })
    describe("#checkTxProof", async () => {
        beforeEach(async () => {
            beginning = await takeSnapshot(signer1.provider);
        });
        afterEach(async () => {
            await revertProvider(signer1.provider, beginning);
        });
        it("Successful checkTxProof execution", async function () {
            await mockBtcLightClient.mock.getChainTipHeight.returns(chainTipHeight);
            await mockBtcLightClient.mock.checkTxProof.returns(true);
            await expect(
                await BitcoinRelay.checkTxProof(
                    txId,
                    initialHeight + 1,
                    txId,
                    0
                )
            ).to.equal(true)
        })
        it("Reverts when txid is zero", async function () {

            await expect(
                BitcoinRelay.checkTxProof(
                    "0x0000000000000000000000000000000000000000000000000000000000000000",
                    1,
                    txId,
                    0
                )
            ).to.be.revertedWith("BitcoinRelay: txid should be non-zero")
        })
        it("Reverts when block on the relay is not yet finalized", async function () {
            await mockBtcLightClient.mock.getChainTipHeight.returns(chainTipHeight);
            await expect(
                BitcoinRelay.checkTxProof(
                    txId,
                    chainTipHeight,
                    txId,
                    0
                )
            ).to.be.revertedWith("BitcoinRelay: block is not finalized on the relay")
        })
        it("Reverts on requesting an excessively old height", async function () {
            await mockBtcLightClient.mock.getChainTipHeight.returns(chainTipHeight);
            await expect(
                BitcoinRelay.checkTxProof(
                    txId,
                    initialHeight - 1,
                    txId,
                    0
                )
            ).to.be.revertedWith("BitcoinRelay: the requested height is not submitted on the relay (too old)")
        })
        it("Reverts when  intermediateNodes length is incorrect", async function () {
            await mockBtcLightClient.mock.getChainTipHeight.returns(chainTipHeight);
            await expect(
                BitcoinRelay.checkTxProof(
                    txId,
                    initialHeight,
                    txId.slice(0, -2),
                    0
                )
            ).to.be.revertedWith("BitcoinRelay: intermediateNode invalid length")
            await expect(
                BitcoinRelay.checkTxProof(
                    txId,
                    initialHeight,
                    txId + "00",
                    0
                )
            ).to.be.revertedWith("BitcoinRelay: intermediateNode invalid length")


        })


    })
    describe("#lastSubmittedHeight", async () => {
        it("Gets lastSubmittedHeight successfully", async function () {
            await mockBtcLightClient.mock.getChainTipHeight.returns(100);
            expect(await BitcoinRelay.lastSubmittedHeight()).to.equal(100)
        })
    })


    describe("#pauseRelay", async () => {
        it("only admin can pause relay", async function () {
            let BitcoinRelay1 = BitcoinRelay.connect(signer1)
            await expect(
                BitcoinRelay1.pauseRelay()
            ).to.be.revertedWith("Ownable: caller is not the owner")

        });

        it("contract paused successsfully", async function () {
            await BitcoinRelay.pauseRelay()
            expect(BitcoinRelay.checkTxProof(
                txId,
                initialHeight,
                txId,
                0
            )).to.revertedWith("Pausable: paused")
        });

        it("can't pause when already paused", async function () {
            await expect(BitcoinRelay.pauseRelay()).to.revertedWith("Pausable: paused")

        });
    })
    describe("#unpauseRelay", async () => {
        it("only admin can un-pause locker", async function () {
            let BitcoinRelay1 = BitcoinRelay.connect(signer1)
            await expect(
                BitcoinRelay1.unpauseRelay()
            ).to.be.revertedWith("Ownable: caller is not the owner")

        });

        it("can't un-pause when already un-paused", async function () {
            await BitcoinRelay.unpauseRelay();
            await expect(
                BitcoinRelay.unpauseRelay()
            ).to.be.revertedWith("Pausable: not paused");

        });

        it("contract un-paused successsfully", async function () {
            await BitcoinRelay.pauseRelay()
            expect(BitcoinRelay.checkTxProof(
                txId,
                initialHeight,
                txId,
                0
            )).to.revertedWith("Pausable: paused")
            await BitcoinRelay.unpauseRelay()
            expect(BitcoinRelay.checkTxProof(
                txId,
                initialHeight,
                txId,
                0
            )).to.not.revertedWith("Pausable: paused")

        });
    })

    describe("#setFinalizationParameter", async () => {
        it("Successfully sets finalization parameter", async function () {
            await expect(BitcoinRelay.setFinalizationParameter(300)).to.emit(
                BitcoinRelay,
                "NewFinalizationParameter"
            )
            expect(await BitcoinRelay.finalizationParameter()).to.equal(300);

        });
        it("Reverts on setting invalid finalization parameter", async function () {
            await expect(BitcoinRelay.setFinalizationParameter(0)).to.revertedWith("BitcoinRelay: invalid finalization param");
            await expect(BitcoinRelay.setFinalizationParameter(MAX_FINALIZATION_PARAMETER + 1)).to.revertedWith("BitcoinRelay: invalid finalization param");
            expect(await BitcoinRelay.finalizationParameter()).to.equal(300);

        });
    })
    describe("#renounce ownership", async () => {
        it("owner can't renounce ownership", async function () {
            await BitcoinRelay.renounceOwnership()
            await expect(
                await BitcoinRelay.owner()
            ).to.equal(deployerAddress);
        })
    });
});