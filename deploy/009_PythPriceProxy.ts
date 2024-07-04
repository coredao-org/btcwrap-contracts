import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import config from 'config'
import {verify} from "../helper-functions"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts, network } = hre;
    const { deploy } = deployments;
    const { deployer } = await getNamedAccounts();

    const pythAddress = config.get("oracle.pyth.address");

    const deployedContract = await deploy("PythPriceProxy", {
        from: deployer,
        log: true,
        skipIfAlreadyDeployed: true,
        args: [
            pythAddress
        ],
    });

    if (network.name != "hardhat" && process.env.ETHERSCAN_API_KEY && process.env.VERIFY_OPTION == "1") {
        await verify(
            deployedContract.address, 
            [pythAddress], 
            "contracts/oracle/price-proxy-impl/PythPriceProxy.sol:PythPriceProxy")
    }
};

export default func;
func.tags = ["PythPriceProxy"];
