interface IHooks {
    function onAccountCreation(address account, bytes calldata data) external returns (bool);
    function onDeposit(address account, uint256 amount) external returns (bool);
    function onWithdraw(address account, uint256 amount) external returns (bool);
    function onVirtualAccountCreation(address virtual, address parent) external returns (bool);
    function onPositionClose(address account) external returns (bool);
}

// Storage: frontend -> selector -> hook contract
mapping(address => mapping(bytes4 => address)) frontendHooks;