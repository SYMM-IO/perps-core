
import "./interfaces/IAccountManager.sol";

contract AccountManager is IAccountManager{
    address public hub;
    address public affiliate;

    modifier onlyHub() {
        require(msg.sender == hub, "AccountManager: Only hub");
        _;
    }

    constructor(address _hub, address _affiliate) external {
        hub = _hub;
        Affiliate = _affiliate;
    }

    // Backward compatible functions
    function addAccount(string memory name) external returns (address) {
        return IAccountsHub(hub).createSubAccount(affiliate, name, "");
    }

    function depositForAccount(address account, uint256 amount) external {
        IAccountsHub(hub).depositForAccount(account, amount);
    }

    function withdrawFromAccount(address account, uint256 amount) external {
        IAccountsHub(hub).withdrawFromAccount(account, amount);
    }

    function _call(address account, bytes[] memory callDatas) external {
        IAccountsHub(hub)._call(account, callDatas);
    }

    function getAccountsLength(address user) external view returns (uint256) {
        return IAccountsHub(hub).getAccountsLength(user);
    }

    function getAccounts(address user, uint256 start, uint256 size) external view returns (IAccountsHub.Account[] memory) {
        return IAccountsHub(hub).getAccounts(user, start, size);
    }

    function getHub() external view returns (address) {
        return hub;
    }

    function getAffiliate() external view returns (address) {
        return affiliate;
    }
}