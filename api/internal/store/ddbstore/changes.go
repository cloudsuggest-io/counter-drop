package ddbstore

import (
	"counter-drop/api/internal/domain"
	"counter-drop/api/internal/realtime"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ChangeEvents turns one DynamoDB Streams record (old and new image of an item) into the live-update
// messages the API's in-memory hub would have published. The messages are pointers ("job X changed"),
// never data: clients refetch through the normal authenticated API.
//
// Job items: every write → job.updated on job:<id>; a new download → file.downloaded; the last file
// deleted → job.files_deleted; and queue.changed on shop:<shop> unless the job is (still) a draft,
// which the shop can't see. Shop items: shop.state (online/paused/offline) or shop.updated.
func ChangeEvents(oldImg, newImg map[string]types.AttributeValue) ([]realtime.Message, error) {
	if newImg == nil { // deletes: nothing to show
		return nil, nil
	}
	sk, _ := newImg["SK"].(*types.AttributeValueMemberS)
	if sk == nil {
		return nil, nil
	}
	switch sk.Value {
	case "JOB":
		return jobChanges(oldImg, newImg)
	case "PROFILE":
		return shopChanges(oldImg, newImg)
	case "ORDER":
		return orderChanges(newImg)
	}
	return nil, nil
}

func jobChanges(oldImg, newImg map[string]types.AttributeValue) ([]realtime.Message, error) {
	var nr, or jobRec
	if err := attributevalue.UnmarshalMap(newImg, &nr); err != nil {
		return nil, err
	}
	if oldImg != nil {
		if err := attributevalue.UnmarshalMap(oldImg, &or); err != nil {
			return nil, err
		}
	}
	j := nr.Job
	jobTopic, shopTopic := realtime.JobTopic(j.ID), realtime.ShopTopic(j.ShopID)
	out := []realtime.Message{{Topic: jobTopic, Event: realtime.Event{Type: "job.updated", Data: map[string]any{"id": j.ID, "state": j.State}}}}

	before := map[string]int{}
	for _, f := range or.Files {
		before[f.F.ID] = f.F.Downloads
	}
	for _, f := range nr.Files {
		if f.F.Downloads > before[f.F.ID] {
			out = append(out, realtime.Message{Topic: jobTopic, Event: realtime.Event{Type: "file.downloaded", Data: map[string]any{"fileId": f.F.ID, "by": f.F.DownloadedBy}}})
		}
	}
	if j.FilesDeletedAt != nil && or.Job.FilesDeletedAt == nil {
		out = append(out, realtime.Message{Topic: jobTopic, Event: realtime.Event{Type: "job.files_deleted", Data: map[string]any{"id": j.ID}}})
	}

	wasDraft := oldImg == nil || or.Job.State == domain.JobStateUploading
	if j.State != domain.JobStateUploading || !wasDraft {
		out = append(out, realtime.Message{Topic: shopTopic, Event: realtime.Event{Type: "queue.changed", Data: map[string]string{"jobId": j.ID, "token": j.Token}}})
	}
	return out, nil
}

func shopChanges(oldImg, newImg map[string]types.AttributeValue) ([]realtime.Message, error) {
	var nr, or shopRec
	if err := attributevalue.UnmarshalMap(newImg, &nr); err != nil {
		return nil, err
	}
	if oldImg != nil {
		if err := attributevalue.UnmarshalMap(oldImg, &or); err != nil {
			return nil, err
		}
	}
	sh := nr.Shop
	ev := realtime.Event{Type: "shop.updated", Data: map[string]any{"id": sh.ID}}
	if oldImg == nil || sh.OnlineState != or.Shop.OnlineState || sh.PauseMessage != or.Shop.PauseMessage {
		ev = realtime.Event{Type: "shop.state", Data: map[string]any{"onlineState": sh.OnlineState}}
	}
	return []realtime.Message{{Topic: realtime.ShopTopic(sh.ID), Event: ev}}, nil
}

// Order items: order.updated on order:<id>, and orders.changed on shop:<shop> once the shop can see it.
func orderChanges(newImg map[string]types.AttributeValue) ([]realtime.Message, error) {
	var r orderRec
	if err := attributevalue.UnmarshalMap(newImg, &r); err != nil {
		return nil, err
	}
	o := r.Order
	out := []realtime.Message{{Topic: realtime.OrderTopic(o.ID), Event: realtime.Event{Type: "order.updated", Data: map[string]any{"id": o.ID, "state": o.State}}}}
	if o.State.Visible() {
		out = append(out, realtime.Message{Topic: realtime.ShopTopic(o.ShopID), Event: realtime.Event{Type: "orders.changed", Data: map[string]string{"orderId": o.ID}}})
	}
	return out, nil
}
