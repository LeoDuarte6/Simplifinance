'use strict';

const authorizenet = require('authorizenet');
require('dotenv').config();

// Correctly destructure all necessary classes from the library
const { APIContracts, Constants, APIControllers } = authorizenet;

function createSubscription(callback) {
	const apiLoginId = process.env.AUTHORIZENET_API_LOGIN_ID;
	const transactionKey = process.env.AUTHORIZENET_TRANSACTION_KEY;

	if (!apiLoginId || !transactionKey) {
		console.error("ERROR: Credentials not found in .env file.");
		return;
	}

	console.log("Attempting to create subscription with Login ID:", apiLoginId);

	const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
	merchantAuthenticationType.setName(apiLoginId);
	merchantAuthenticationType.setTransactionKey(transactionKey);

	const interval = new APIContracts.PaymentScheduleType.Interval();
	interval.setLength(1);
	interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);

	const paymentSchedule = new APIContracts.PaymentScheduleType();
	paymentSchedule.setInterval(interval);
	paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10));
	paymentSchedule.setTotalOccurrences(9999);

	const creditCard = new APIContracts.CreditCardType();
	creditCard.setCardNumber('4007000000027');
	creditCard.setExpirationDate('2027-12');

	const payment = new APIContracts.PaymentType();
	payment.setCreditCard(creditCard);

	const billTo = new APIContracts.NameAndAddressType();
	billTo.setFirstName('John');
	billTo.setLastName('Doe');

	const arbSubscription = new APIContracts.ARBSubscriptionType();
	arbSubscription.setName('Premium Plan Test');
	arbSubscription.setPaymentSchedule(paymentSchedule);
	arbSubscription.setAmount('199.00');
	arbSubscription.setPayment(payment);
	arbSubscription.setBillTo(billTo);

	const createRequest = new APIContracts.ARBCreateSubscriptionRequest();
	createRequest.setMerchantAuthentication(merchantAuthenticationType);
	createRequest.setSubscription(arbSubscription);

	// This is the corrected controller instantiation, using APIControllers
	const ctrl = new APIControllers.ARBCreateSubscriptionController(createRequest.getJSON());
	
	ctrl.setEnvironment(Constants.endpoint.sandbox);

	ctrl.execute(function(){
		const apiResponse = ctrl.getResponse();
		const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);

		console.log('\n--- Full Response from Server ---');
		console.log(JSON.stringify(response, null, 2));
		console.log('---------------------------------\n');

		if(response != null){
			if(response.getMessages().getResultCode() == APIContracts.MessageTypeEnum.OK){
				console.log('--- SUCCESS! ---');
				console.log('Subscription ID: ' + response.getSubscriptionId());
			}
			else {
				console.error("--- TEST FAILED ---");
				if (response.getMessages().getMessage()) {
					console.error('Error Code: ' + response.getMessages().getMessage()[0].getCode());
					console.error('Error Text: ' + response.getMessages().getMessage()[0].getText());
				}
			}
		}
		else {
			console.error("--- TEST FAILED ---");
			console.error('Null response from server');
		}

		if(callback) callback(response);
	});
}

// --- Run the script ---
if (require.main === module) {
	createSubscription(function(){
		console.log('\nScript finished.');
	});
}